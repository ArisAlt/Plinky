// Automatic session logs: with Settings > Logging on, or a session's own
// "Log this session", every connection is written to
// <log folder>/<session folder>/<session>/<YYYY-MM-DD_HH-MM-SS>.log, and a
// console that isn't saved (GNS3) under Unsaved. Checked on disk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startConsole, writePuttySession, waitUntil } from '../lib/fixtures.mjs';

export const title = 'Automatic session logs';

export async function setup({ home }) {
  const r7 = await startConsole({ name: 'R7' });
  const r8 = await startConsole({ name: 'R8' });
  const r9 = await startConsole({ name: 'R9' });
  writePuttySession(home, 'Core R7', { HostName: '127.0.0.1', PortNumber: r7.port, Protocol: 'telnet', PlinkyFolder: 'Lab/Core' });
  writePuttySession(home, 'Quiet R8', { HostName: '127.0.0.1', PortNumber: r8.port, Protocol: 'telnet', PlinkyFolder: 'Lab', PlinkyAutoLog: '0' });
  writePuttySession(home, 'Always R7', { HostName: '127.0.0.1', PortNumber: r7.port, Protocol: 'telnet', PlinkyFolder: 'Lab', PlinkyAutoLog: '1' });
  return {
    state: { r7, r8, r9, logs: path.join(home, 'session-logs') },
    cleanup: async () => { await r7.stop(); await r8.stop(); await r9.stop(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every file under `dir`, relative, with / separators. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/'))
    .sort();
}

const STAMP = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(_\d+)?\.log$/;

async function openSaved(app, name) {
  await app.run((e, n) => {
    const row = document.querySelector(`[data-session-row="${CSS.escape(n)}"]`);
    row.scrollIntoView();
    return e.dblclick(row);
  }, name);
  await app.waitForTab(name, 'live', { timeoutMs: 5000 });
}

async function command(app, con, text) {
  await app.run((e) => e.focusTerminal());
  await app.type(text);
  await app.key('Enter');
  await con.waitForLine(text, { timeoutMs: 5000 });
}

async function closeActiveTab(app) {
  await app.run((e) => e.focusTerminal());
  await app.key('Ctrl+Shift+W');
  await app.waitFor(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Close tab');
    if (b) window.__e2e.click(b);
    return !!b;
  }, [], { what: 'the Close tab button' });
}

export const tests = [
  ['with logging off, a session is not logged', async ({ app, r7, logs }) => {
    await app.waitFor(() => !!document.querySelector('[data-session-row="Core R7"]'), [], { what: 'the session list', timeoutMs: 5000 });
    // Off, but pointing at this test's folder, so nothing can land elsewhere.
    const s = await app.invoke('set_logging_settings', { enabled: false, dir: logs, mode: 'printable' });
    assert.equal(s.enabled, false);
    assert.equal(s.dir, logs);
    await openSaved(app, 'Core R7');
    await command(app, r7, 'show clock');
    await sleep(300);
    assert.deepEqual(filesUnder(logs), []);
    await closeActiveTab(app);
  }],

  ['with logging on, each connection is a file under folder/session/time, with what the device said', async ({ app, r7, logs }) => {
    await app.invoke('set_logging_settings', { enabled: true, dir: logs, mode: 'printable' });
    await openSaved(app, 'Core R7');
    await command(app, r7, 'show version');
    await app.waitForScreen('you typed: show version');
    const [file, ...rest] = filesUnder(logs);
    assert.equal(rest.length, 0, `one log, got ${JSON.stringify(filesUnder(logs))}`);
    assert.match(file, /^Lab\/Core\/Core R7\//, 'nested folder, then the session');
    assert.match(path.basename(file), STAMP);
    await waitUntil(() => fs.readFileSync(path.join(logs, file), 'utf8').includes('you typed: show version'),
      { what: 'the device\'s reply in the log', timeoutMs: 3000 });
    // Text only: no colour codes or carriage returns.
    assert.doesNotMatch(fs.readFileSync(path.join(logs, file), 'utf8'), /\x1b|\r/);
    // The tab says it is logging, and where.
    await app.waitFor(() => [...document.querySelectorAll('button')].some((b) => window.__e2e.visible(b) && /^Log: \d/.test(b.textContent.trim())),
      [], { what: 'the tab\'s Log button to show it is logging', timeoutMs: 4000 });
    await closeActiveTab(app);
  }],

  ['a session set to Never is not logged, even with logging on', async ({ app, r8, logs }) => {
    const before = filesUnder(logs);
    await openSaved(app, 'Quiet R8');
    await command(app, r8, 'show clock');
    await sleep(300);
    assert.deepEqual(filesUnder(logs), before);
    await closeActiveTab(app);
  }],

  ['a session set to Always is logged, even with logging off', async ({ app, r7, logs }) => {
    await app.invoke('set_logging_settings', { enabled: false, dir: logs, mode: 'printable' });
    await openSaved(app, 'Always R7');
    await command(app, r7, 'show users');
    const mine = () => filesUnder(logs).filter((f) => f.startsWith('Lab/Always R7/'));
    await waitUntil(() => mine().length === 1, { what: 'Always R7\'s log', timeoutMs: 3000 });
    await waitUntil(() => fs.readFileSync(path.join(logs, mine()[0]), 'utf8').includes('you typed: show users'),
      { what: 'the reply in Always R7\'s log', timeoutMs: 3000 });
    await closeActiveTab(app);
  }],

  ['a GNS3 console, not saved, is logged under Unsaved by its title', async ({ app, r9, logs }) => {
    await app.invoke('set_logging_settings', { enabled: true, dir: logs, mode: 'printable' });
    // GNS3 launches the app again per console; the running one takes it.
    const second = await new Promise((resolve) => {
      const child = spawn(app.child.spawnargs[0], ['--telnet', '127.0.0.1', String(r9.port), '--title', 'R9'], { env: app.env, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 8000);
      child.on('exit', () => { clearTimeout(timer); resolve(true); });
    });
    assert.ok(second, 'the second launch hands over and exits');
    await app.waitForTab('R9', 'live', { timeoutMs: 5000 });
    await command(app, r9, 'show ip route');
    const mine = () => filesUnder(logs).filter((f) => f.startsWith('Unsaved/R9/'));
    await waitUntil(() => mine().length === 1, { what: 'R9\'s log under Unsaved', timeoutMs: 3000 })
      .catch((e) => { throw new Error(`${e.message}; logs: ${JSON.stringify(filesUnder(logs))}`); });
    assert.match(path.basename(mine()[0]), STAMP);
    await waitUntil(() => fs.readFileSync(path.join(logs, mine()[0]), 'utf8').includes('you typed: show ip route'),
      { what: 'the reply in R9\'s log', timeoutMs: 3000 });
  }],

  ['Reconnect starts a new log file in the same place', async ({ app, r9, logs }) => {
    const mine = () => filesUnder(logs).filter((f) => f.startsWith('Unsaved/R9/'));
    // Two files in the same second get a suffix; a second apart is the norm.
    await sleep(1100);
    r9.hangUp();
    await app.waitForTab('R9', 'disconnected', { timeoutMs: 3000 });
    await app.waitFor(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Reconnect' && window.__e2e.visible(x));
      if (b) window.__e2e.click(b);
      return !!b;
    }, [], { what: 'a Reconnect button' });
    await app.waitForTab('R9', 'live', { timeoutMs: 5000 });
    await command(app, r9, 'show arp');
    await waitUntil(() => mine().length === 2, { what: 'a second log under Unsaved/R9', timeoutMs: 3000 })
      .catch((e) => { throw new Error(`${e.message}; logs: ${JSON.stringify(filesUnder(logs))}`); });
    const newest = mine().sort().at(-1);
    await waitUntil(() => fs.readFileSync(path.join(logs, newest), 'utf8').includes('you typed: show arp'),
      { what: 'the reply in the new log', timeoutMs: 3000 });
  }],

  ['Session Settings saves "Log this session" with the session', async ({ app }) => {
    await app.run((e) => {
      const btn = document.querySelector('button[aria-label="Edit Core R7"]');
      btn.scrollIntoView();
      return e.click(btn);
    });
    await app.waitFor(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'), [], { what: 'the session editor' });
    await app.run((e) => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim().startsWith('Advanced'));
      return e.click(tab);
    });
    await app.waitFor(() => !!document.querySelector('select[aria-label="Log this session"]'), [], { what: 'Log this session' });
    await app.run(() => {
      const sel = document.querySelector('select[aria-label="Log this session"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'never');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    await app.run((e) => e.click([...document.querySelectorAll('button[type="submit"]')].find((x) => /Save Changes/.test(x.textContent))));
    await waitUntil(async () => (await app.invoke('list_putty_sessions')).find((s) => s.name === 'Core R7')?.extra?.PlinkyAutoLog === '0',
      { what: 'PlinkyAutoLog=0 saved', timeoutMs: 3000 });
  }],
];
