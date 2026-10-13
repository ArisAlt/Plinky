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
    if (base) fs.rmSync(path.join(base, IDENTIFIER), { recursive: true, force: true });
  }
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
