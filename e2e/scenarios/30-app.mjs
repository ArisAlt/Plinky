// The app around the terminals: the local shell, GNS3 opening consoles in a
// window that is already open, and a long session list.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startConsole, writePuttySession, waitUntil, freePort } from '../lib/fixtures.mjs';

export const title = 'The app: local shell, GNS3 hand-over, session list';

export async function setup({ home }) {
  // Enough saved sessions that the list has to scroll.
  for (let i = 1; i <= 60; i++) {
    writePuttySession(home, `Router ${String(i).padStart(2, '0')}`, {
      HostName: '192.0.2.1', PortNumber: 5000 + i, Protocol: 'telnet',
    });
  }
  const consoles = await Promise.all(['R1', 'R2', 'R3', 'R4'].map((name) => startConsole({ name })));
  // A console saved as a session, opened from the list.
  writePuttySession(home, 'Core R4', { HostName: '127.0.0.1', PortNumber: consoles[3].port, Protocol: 'telnet' });
  return {
    // A known shell for the local shell tab: bash, with no startup files in
    // the throwaway home.
    env: { SHELL: '/bin/bash' },
    state: { consoles },
    cleanup: () => Promise.all(consoles.map((c) => c.stop())),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Launches the app again with the same environment, the way GNS3 launches it
// for each console. The running window should take the console and the new
// process should exit.
function launchAgain(app, args) {
  return new Promise((resolve) => {
    const child = spawn(app.child.spawnargs[0], args, { env: app.env, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ exited: false }); }, 8000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ exited: true, code }); });
  });
}

export const tests = [
  ['Ctrl+Shift+T opens the tab menu, and Local Shell opens a ready shell', async ({ app }) => {
    await app.run(() => document.body.focus());
    await app.key('Ctrl+Shift+T');
    await app.waitFor((e) => {
      const b = [...document.querySelectorAll('[role="option"]')].find((x) => x.textContent.trim() === 'Local Shell');
      if (b) e.click(b);
      return !!b;
    }, [], { what: 'Local Shell in the tab menu' });
    await app.waitForTab('Local Shell', 'live', { timeoutMs: 5000 });
    await app.run((e) => e.focusTerminal());
    await app.type('echo "sum=$((40+2))"');
    await app.key('Enter');
    await app.waitForScreen('sum=42', { timeoutMs: 5000 });
  }],

  ['a console GNS3 opens while the app is running becomes a tab in the same window', async ({ app, consoles }) => {
    const [r1] = consoles;
    const before = (await app.tabs()).length;
    const second = await launchAgain(app, ['--telnet', '127.0.0.1', String(r1.port), '--title', 'R1']);
    assert.ok(second.exited, 'the second launch hands over and exits');
    await app.waitForTab('R1', 'live', { timeoutMs: 5000 });
    assert.equal((await app.tabs()).length, before + 1);
    assert.equal(r1.connections, 1);
  }],

  ['consoles opened together are all ready, not only the one in front', async ({ app, consoles }) => {
    // GNS3's "console to all nodes" launches the app once per node. The
    // tabs behind the front one stayed "connecting" although connected.
    const [, r2, r3] = consoles;
    await Promise.all([
      launchAgain(app, ['--telnet', '127.0.0.1', String(r2.port), '--title', 'R2']),
      launchAgain(app, ['--telnet', '127.0.0.1', String(r3.port), '--title', 'R3']),
    ]);
    await waitUntil(() => r2.connections === 1 && r3.connections === 1, { what: 'both consoles connected', timeoutMs: 5000 });
    await sleep(1500);
    const tabs = (await app.tabs()).filter((t) => t.title === 'R2' || t.title === 'R3');
    assert.deepEqual(tabs.map((t) => `${t.title}:${t.status}`).sort(), ['R2:live', 'R3:live']);
  }],

  ['a console that refuses the connection shows as disconnected, also once opened', async ({ app, consoles }) => {
    // Seen on Windows: a GNS3 console behind the front tab got "Connection
    // refused", and its tab showed the amber key ("login pending") instead.
    const closed = await freePort();
    await launchAgain(app, [
      '--telnet', '127.0.0.1', String(closed), '--title', 'Down',
      '--telnet', '127.0.0.1', String(consoles[0].port), '--title', 'R1 again',
    ]);
    await app.waitForTab('R1 again', 'live', { timeoutMs: 5000 });
    await sleep(1500);
    const behind = (await app.tabs()).find((t) => t.title === 'Down');
    await app.run((e) => e.click(e.tabEl('Down')));
    await sleep(1000);
    const opened = (await app.tabs()).find((t) => t.title === 'Down');
    assert.deepEqual({ behind: behind.status, opened: opened.status }, { behind: 'disconnected', opened: 'disconnected' });
  }],

  ['a saved telnet session opens ready at once, though the router prints nothing', async ({ app, consoles }) => {
    // Saved console sessions showed "Connecting to host:port" for ~10 s.
    const r4 = consoles[3];
    await app.run((e) => {
      const row = document.querySelector('[data-session-row="Core R4"]');
      row.scrollIntoView();
      return e.dblclick(row);
    });
    const started = Date.now();
    await app.waitForTab('Core R4', 'live', { timeoutMs: 3000 });
    assert.equal(r4.connections, 1);
    assert.ok(Date.now() - started < 2000);
    assert.doesNotMatch(await app.screenText(), /connecting/i);
  }],

  ['a long session list scrolls and the right-click menu of its last entry fits the window', async ({ app }) => {
    const list = await app.run(() => {
      const last = document.querySelector('[data-session-row="Router 60"]');
      last.scrollIntoView({ block: 'end' });
      const r = last.getBoundingClientRect();
      return { bottom: r.bottom, height: window.innerHeight };
    });
    assert.ok(list.bottom <= list.height, 'the last session can be scrolled into view');
    await app.run((e) => e.rightClick(document.querySelector('[data-session-row="Router 60"]')));
    await app.waitFor(() => [...document.querySelectorAll('[role="menu"]')].some((x) => window.__e2e.visible(x)), [], { what: 'the session menu' });
    await sleep(300); // it opens with a zoom-in; measure where it comes to rest
    const menu = await app.waitFor(() => {
      const m = [...document.querySelectorAll('[role="menu"]')].find((x) => window.__e2e.visible(x));
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: innerWidth, h: innerHeight };
    }, [], { what: 'the session menu' });
    assert.ok(menu.top >= 0 && menu.bottom <= menu.h && menu.left >= 0 && menu.right <= menu.w,
      `the menu ${JSON.stringify(menu)} is inside the window`);
  }],
];
