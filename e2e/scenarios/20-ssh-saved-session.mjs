// A saved PuTTY session to an SSH server, opened from the session list: the
// first-visit host key question, a key login, and what the remote shell sees.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { startSshd, writePuttySession, waitUntil } from '../lib/fixtures.mjs';

export const title = 'SSH to a saved session';

export async function setup({ home, runDir }) {
  const sshd = await startSshd(path.join(runDir, 'sshd'));
  if (!sshd) return { skip: 'needs sshd, ssh-keygen and puttygen' };
  writePuttySession(home, 'Lab Server', {
    HostName: '127.0.0.1',
    PortNumber: sshd.port,
    Protocol: 'ssh',
    UserName: os.userInfo().username,
    PublicKeyFile: sshd.ppk,
  });
  return { state: { sshd }, cleanup: () => sshd.stop() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs a shell command and returns the screen text after its marker line.
async function shell(app, cmd, marker) {
  await app.run((e) => e.focusTerminal());
  await app.type(cmd);
  await app.key('Enter');
  await app.waitForScreen(marker, { timeoutMs: 5000 });
  return app.screenText();
}

const clickButton = (app, text) => app.waitFor((e, t) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t && e.visible(x));
  if (b) e.click(b);
  return !!b;
}, [text], { what: `a "${text}" button` });

export const tests = [
  ['the saved session is in the session list', async ({ app }) => {
    await app.waitFor(() => !!document.querySelector('[data-session-row="Lab Server"]'), [], { what: 'the session in the list' });
  }],

  ['opening it asks about the new host key and shows its real fingerprint', async ({ app, sshd }) => {
    await app.run((e) => e.dblclick(document.querySelector('[data-session-row="Lab Server"]')));
    const dialog = await app.waitFor(() => {
      const d = document.querySelector('[aria-labelledby="hostkey-title"]');
      return d ? d.innerText : null;
    }, [], { what: 'the host key question', timeoutMs: 8000 });
    assert.match(dialog, /New host/);
    assert.ok(dialog.includes(sshd.fingerprint), `the dialog shows ${sshd.fingerprint}:\n${dialog}`);
  }],

  ['trusting the key logs in with the saved key and the tab is ready', async ({ app }) => {
    await clickButton(app, 'Trust and store key');
    await app.waitForScreen('e2e$', { timeoutMs: 8000 });
    await app.waitForTab('Lab Server', 'live', { timeoutMs: 3000 });
  }],

  ['commands run and their output shows', async ({ app }) => {
    const screen = await shell(app, 'echo "answer=$((6*7))"', 'answer=42');
    assert.match(screen, /answer=42/);
  }],

  ['the remote shell is told the size the terminal shows', async ({ app }) => {
    const size = await app.run((e) => e.termSize());
    const screen = await shell(app, 'echo "size=$(stty size)"', /size=\d+ \d+/);
    const [, rows, cols] = screen.match(/size=(\d+) (\d+)/);
    assert.deepEqual({ rows: Number(rows), cols: Number(cols) }, size);
  }],

  ['TERM is xterm, like PuTTY', async ({ app }) => {
    const screen = await shell(app, 'echo "term=$TERM"', /term=\S+/);
    assert.match(screen, /term=xterm\b/);
  }],

  ['Ctrl+C stops a running command', async ({ app }) => {
    await app.run((e) => e.focusTerminal());
    await app.type('sleep 30; echo slept');
    await app.key('Enter');
    await sleep(400);
    const started = Date.now();
    await app.key('Ctrl+C');
    await app.waitFor((e) => {
      const lines = (e.screen() ?? []).filter((l) => l.trim());
      return lines.at(-1)?.startsWith('e2e$') && !lines.some((l) => l === 'slept');
    }, [], { what: 'the prompt back after Ctrl+C', timeoutMs: 3000 });
    assert.ok(Date.now() - started < 3000);
  }],

  ['a second connection does not ask about the key again', async ({ app }) => {
    await app.run((e) => e.dblclick(document.querySelector('[data-session-row="Lab Server"]')));
    await app.waitFor((e) => e.tabs().length === 2, [], { what: 'a second tab' });
    await app.waitForScreen('e2e$', { timeoutMs: 8000 });
    const asked = await app.run(() => !!document.querySelector('[aria-labelledby="hostkey-title"]'));
    assert.equal(asked, false, 'the stored key is used');
    await app.waitFor((e) => e.tabs().every((t) => t.status === 'live'), [], { what: 'both tabs ready' });
  }],

  ['switching tabs and back keeps both logged-in tabs ready', async ({ app }) => {
    // An SSH tab went amber ("waiting for login") after being switched back
    // to: the redraw on reattach was read as a new login prompt.
    for (let i = 0; i < 4; i++) {
      await app.run((e) => e.focusTerminal());
      await app.key('Ctrl+Tab');
      await sleep(300);
    }
    const tabs = await app.tabs();
    assert.deepEqual(tabs.map((t) => t.status), ['live', 'live']);
  }],

  ['typing exit leaves the tab open, disconnected, with Reconnect', async ({ app }) => {
    // Unlike PuTTY, which closes the window on a clean exit: the tab stays,
    // so the session's output can still be read and reconnected from.
    const before = (await app.tabs()).length;
    await app.run((e) => e.focusTerminal());
    await app.type('exit');
    await app.key('Enter');
    await app.waitFor((e) => e.tabs().some((t) => t.active && t.status === 'disconnected'), [], { what: 'the tab to show disconnected' });
    assert.equal((await app.tabs()).length, before, 'the tab stays open');
    await app.waitFor((e) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Reconnect' && e.visible(b)), [], { what: 'a Reconnect button' });
  }],
];
