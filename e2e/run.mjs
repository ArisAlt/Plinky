#!/usr/bin/env node
// End-to-end tests: the real app, its real backend and PuTTY's real plink,
// against stand-in router consoles and a private sshd, on a screen nobody
// sees. Unit tests stub the terminal, the backend or the network; most of the
// bugs that reached users were in the joins between them, which only this
// catches.
//
//   node e2e/run.mjs --build          build the app for testing, then run
//   node e2e/run.mjs                  run against the last test build
//   node e2e/run.mjs --only paste     only tests whose name contains "paste"
//   node e2e/run.mjs --visible        show the windows on your desktop
//   node e2e/run.mjs --keep           keep the test profiles for inspection
//
// Linux only for now. Needs Node 22+, plink, and kwin_wayland or Xvfb; the
// SSH tests also need sshd, ssh-keygen and puttygen, and skip without them.
//
// The app under test is a debug build (see --build): WebKit's inspector,
// which the suite drives the page through, is only on in debug builds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDisplay } from './lib/display.mjs';
import { launchApp } from './lib/app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const only = option('--only')?.toLowerCase();
const binary = path.resolve(option('--binary') ?? path.join(root, 'target/debug/plinky-desktop'));

const color = process.stdout.isTTY
  ? { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` }
  : { red: (s) => s, green: (s) => s, dim: (s) => s, yellow: (s) => s };

function preflight() {
  if (process.platform !== 'linux') throw new Error('the end-to-end suite runs on Linux only for now');
  if (typeof WebSocket === 'undefined') throw new Error(`Node 22 or newer is needed (this is ${process.version})`);
  try { execFileSync('plink', ['-V'], { stdio: 'ignore' }); } catch (e) {
    if (e.code === 'ENOENT') throw new Error('plink is not on PATH: install PuTTY');
  }
  if (flag('--build')) {
    console.log(color.dim('building the app for testing (debug, frontend embedded)...'));
    const r = spawnSync('npx', ['tauri', 'build', '--debug', '--no-bundle', '--ignore-version-mismatches'], {
      cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (r.status !== 0) throw new Error('the build failed');
  }
  if (!fs.existsSync(binary)) throw new Error(`no app at ${binary}: run with --build first`);
  // A plain `cargo build` binary loads the page from the Vite dev server
  // and shows a blank window without it. Only `tauri build --debug` embeds it.
  const age = (Date.now() - fs.statSync(binary).mtimeMs) / 3600e3;
  if (age > 24) console.log(color.yellow(`note: the app under test was built ${Math.round(age)} h ago; --build rebuilds it`));
}

async function main() {
  preflight();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plinky-e2e-'));
  const display = await startDisplay({ runDir, visible: flag('--visible') });
  console.log(color.dim(`app: ${path.relative(root, binary)}   screen: ${display.kind}   files: ${runDir}`));

  const files = fs.readdirSync(path.join(here, 'scenarios')).filter((f) => f.endsWith('.mjs')).sort();
  const results = [];
  try {
    for (const file of files) {
      const scenario = await import(pathToFileURL(path.join(here, 'scenarios', file)));
      // A scenario's tests are steps on one running app: each starts where
      // the one before left off. --only runs a matching test's earlier steps
      // too, as preparation, and reports them only if they fail.
      const wanted = (name) => !only || name.toLowerCase().includes(only) || file.includes(only);
      const last = scenario.tests.findLastIndex(([name]) => wanted(name));
      if (last < 0) continue;
      const tests = scenario.tests.slice(0, last + 1).map(([name, fn, opts]) => [name, fn, opts, wanted(name)]);
      console.log(`\n${scenario.title}`);

      const home = fs.mkdtempSync(path.join(runDir, `${path.basename(file, '.mjs')}-`));
      const ctx = { home, runDir, binary, display, launch: (opts) => launchApp({ binary, display, home, ...opts }) };
      let prepared;
      try {
        prepared = await scenario.setup(ctx);
      } catch (e) {
        for (const [name, , , shown] of tests) if (shown) results.push({ file, name, ok: false, error: `setup failed: ${e.stack}` });
        console.log(color.red(`  setup failed: ${e.message}`));
        continue;
      }
      if (prepared.skip) {
        for (const [name, , , shown] of tests) if (shown) results.push({ file, name, skipped: prepared.skip });
        console.log(color.yellow(`  skipped: ${prepared.skip}`));
        continue;
      }

      let app;
      try {
        app = await ctx.launch({ args: prepared.args ?? [], env: prepared.env ?? {} });
        for (const [name, fn, opts = {}, shown] of tests) {
          const started = Date.now();
          try {
            await withTimeout(fn({ app, ...prepared.state, ctx }), opts.timeoutMs ?? 30000, name);
            if (!shown) continue;
            results.push({ file, name, ok: true });
            console.log(`  ${color.green('✓')} ${name} ${color.dim(`${Date.now() - started} ms`)}`);
          } catch (e) {
            const scene = await snapshot(app);
            const label = shown ? name : `${name} (an earlier step of the one asked for)`;
            results.push({ file, name: label, ok: false, error: e.message, scene });
            console.log(`  ${color.red('✗')} ${label}`);
            console.log(indent(color.red(e.message), 6));
            if (scene) console.log(indent(color.dim(scene), 6));
            if (app.exited) break; // the app died; every later test would fail the same way
            await app.run((p) => p.dismissAll()).catch(() => {});
          }
        }
      } catch (e) {
        for (const [name, , , shown] of tests) if (shown && !results.some((r) => r.file === file && r.name === name)) {
          results.push({ file, name, ok: false, error: e.message });
        }
        console.log(color.red(`  could not start the app: ${e.message}`));
      } finally {
        await app?.stop();
        await prepared.cleanup?.();
      }
    }
  } finally {
    display.stop();
    if (!flag('--keep')) fs.rmSync(runDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${passed} passed, ${failed.length ? color.red(`${failed.length} failed`) : '0 failed'}${skipped ? `, ${skipped} skipped` : ''}`);
  for (const f of failed) console.log(color.red(`  ✗ ${f.name}`));
  if (flag('--keep')) console.log(color.dim(`profiles and logs kept in ${runDir}`));
  process.exitCode = failed.length ? 1 : 0;
}

async function snapshot(app) {
  try {
    const s = await app.run((e) => ({ tabs: e.tabs(), dialogs: e.dialogs(), screen: e.screen() }));
    const screen = (s.screen ?? []).filter((l) => l.trim()).slice(-12).join('\n');
    return [
      `tabs: ${s.tabs.map((t) => `${t.title}[${t.status}${t.active ? ',active' : ''}]`).join(' ') || '(none)'}`,
      s.dialogs.length ? `dialogs: ${s.dialogs.join(' | ').slice(0, 300)}` : null,
      screen ? `screen (last lines):\n${indent(screen, 2)}` : null,
    ].filter(Boolean).join('\n');
  } catch {
    return app.exited ? `the app exited (${JSON.stringify(app.exited)}); log: ${app.log}` : null;
  }
}

function withTimeout(promise, ms, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`"${name}" took longer than ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const indent = (s, n) => s.split('\n').map((l) => ' '.repeat(n) + l).join('\n');

main().catch((e) => { console.error(color.red(e.message)); process.exitCode = 2; });
