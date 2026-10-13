// What the suite needs on Windows, where a profile can't be pointed at a
// throwaway folder: PuTTY keeps saved sessions in the registry, and the app
// keeps its data and WebView2's storage in fixed folders under %APPDATA% and
// %LOCALAPPDATA%. Each scenario starts from a clean slate by deleting them,
// which is only done on a CI runner (CI=true): on anyone's own machine it
// would delete their sessions and their vault.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const isWindows = process.platform === 'win32';
const IDENTIFIER = 'com.thyrion.desktop';
export const SESSIONS_KEY = 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions';

/** WebView2's DevTools port in the test build. WebView2 ignores
 *  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS once the app passes arguments of
 *  its own, as Tauri always does (measured on the runner: app and WebView2
 *  up, nothing listening), so the port is set in the test build's window
 *  config (testBuildConfig) and is fixed. Never in a release build: with it
 *  any local program could drive the page, the vault included. */
export const DEVTOOLS_PORT = 9333;

/** A `tauri build --config` overlay for the test build: the window as
 *  tauri.conf.json has it, plus WebView2's DevTools port. Tauri's own
 *  default arguments are kept, since setting any replaces them. */
export function testBuildConfig(confPath, outPath) {
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  const windows = conf.app.windows.map((w) => ({
    ...w,
    additionalBrowserArgs: [
      '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection',
      `--remote-debugging-port=${DEVTOOLS_PORT}`,
      '--remote-allow-origins=*',
    ].join(' '),
  }));
  fs.writeFileSync(outPath, JSON.stringify({ app: { windows } }, null, 2));
  return outPath;
}

export function assertThrowawayMachine() {
  if (process.env.CI !== 'true') {
    throw new Error(
      'on Windows the suite deletes the saved PuTTY sessions in the registry and Thyrion\'s data folders ' +
      'before each scenario, so it runs only on a CI runner (CI=true)',
    );
  }
}

/** Deletes the saved sessions and the app's data, before a scenario. */
export function resetProfile() {
  assertThrowawayMachine();
  try { execFileSync('reg', ['delete', SESSIONS_KEY, '/f'], { stdio: 'ignore' }); } catch { /* none yet */ }
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (base) removeWhenFree(path.join(base, IDENTIFIER));
  }
}

// WebView2's helper processes outlive the app by a moment and keep its
// cache open: the first run failed with EBUSY on Cache_Data\index. Wait for
// them, and on the runner end any that are left.
function removeWhenFree(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(e.code) || attempt >= 20) throw e;
      if (attempt === 10) {
        try { execFileSync('taskkill', ['/IM', 'msedgewebview2.exe', '/F'], { stdio: 'ignore' }); } catch { /* none */ }
      }
      execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], { stdio: 'ignore' });
    }
  }
}

/** What was running and listening when the app's DevTools port never
 *  answered: for the CI log. */
export function windowsDiagnosis(port, child) {
  const run = (cmd, args) => {
    try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch (e) { return `(${cmd} failed: ${e.message})`; }
  };
  const tasks = run('tasklist', ['/FO', 'CSV', '/NH']).split(/\r?\n/)
    .filter((l) => /thyrion|msedgewebview2|plink/i.test(l)).join('\n');
  const listening = run('netstat', ['-ano', '-p', 'TCP']).split(/\r?\n/)
    .filter((l) => l.includes(`:${port} `) || l.includes(`:${port}\t`)).join('\n');
  return `\n--- app process ${child.pid}, exited: ${child.exitCode ?? 'no'} ---\n${tasks || '(no thyrion or WebView2 processes)'}` +
    `\n--- port ${port} ---\n${listening || '(nothing listening)'}`;
}

/** PuTTY's escape_registry_key (crates/putty-compat/src/registry.rs), for
 *  the ASCII names the tests use. */
export function escapeRegistryKey(name) {
  return [...Buffer.from(name, 'latin1')].map((b, i) =>
    ([0x20, 0x5c, 0x2a, 0x3f, 0x25].includes(b) || b < 0x20 || b > 0x7e || (b === 0x2e && i === 0))
      ? `%${b.toString(16).toUpperCase().padStart(2, '0')}`
      : String.fromCharCode(b)).join('');
}

// The settings the tests write that PuTTY stores as REG_DWORD; PuTTY ignores
// a number saved as a string (the full list is DWORD_SETTINGS in registry.rs).
const DWORD = new Set(['PortNumber', 'SerialSpeed', 'SerialDataBits', 'SerialStopHalfbits', 'SerialParity',
  'SerialFlowControl', 'CloseOnExit', 'TermWidth', 'TermHeight', 'ScrollbackLines']);

/** Writes a saved session where PuTTY on Windows keeps it. */
export function writeRegistrySession(name, settings) {
  assertThrowawayMachine();
  const key = `${SESSIONS_KEY}\\${escapeRegistryKey(name)}`;
  execFileSync('reg', ['add', key, '/f'], { stdio: 'ignore' });
  for (const [k, v] of Object.entries(settings)) {
    const dword = DWORD.has(k) && /^-?\d+$/.test(String(v));
    execFileSync('reg', ['add', key, '/v', k, '/t', dword ? 'REG_DWORD' : 'REG_SZ', '/d', String(v), '/f'], { stdio: 'ignore' });
  }
}

/** Ends a process and everything it started (plink, a local shell). */
export function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
