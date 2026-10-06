// SecureCRT-style session features: logon actions, a tab colour, and a tab
// locked read only.
import assert from 'node:assert/strict';
import { startConsole, writePuttySession, waitUntil } from '../lib/fixtures.mjs';

export const title = 'Logon actions, tab colour, locked tab';

export async function setup({ home }) {
  const r5 = await startConsole({ name: 'R5', greet: true });
  writePuttySession(home, 'Core R5', {
    HostName: '127.0.0.1', PortNumber: r5.port, Protocol: 'telnet',
    PlinkyLogonActions: JSON.stringify([['>', 'terminal length 0'], ['', 'show clock']]),
    PlinkyTabColor: 'red',
  });
  return { state: { r5 }, cleanup: () => r5.stop() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const tests = [
  ['logon actions are typed once the session is up, in order', async ({ app, r5 }) => {
    await app.waitFor(() => !!document.querySelector('[data-session-row="Core R5"]'), [], { what: 'the session in the list' });
    await app.run((e) => e.dblclick(document.querySelector('[data-session-row="Core R5"]')));
    await app.waitForTab('Core R5', 'live', { timeoutMs: 5000 });
    await r5.waitForLine('show clock', { timeoutMs: 8000 });
    assert.deepEqual(r5.lines, ['terminal length 0', 'show clock']);
    await sleep(500);
    assert.deepEqual(r5.lines, ['terminal length 0', 'show clock'], 'each action is typed once');
  }],

  ['the session\'s colour shows on its tab and its row', async ({ app }) => {
    const colours = await app.run((e) => ({
      tab: e.tabEl('Core R5').style.borderTopColor,
      row: [...document.querySelector('[data-session-row="Core R5"]').querySelectorAll('span[aria-hidden]')]
        .map((s) => s.style.backgroundColor).find(Boolean) ?? null,
    }));
    assert.deepEqual(colours, { tab: 'rgb(239, 68, 68)', row: 'rgb(239, 68, 68)' });
  }],

  ['a locked tab sends nothing typed, says why, and types again once unlocked', async ({ app, r5 }) => {
    await app.run((e) => e.rightClick(e.tabEl('Core R5')));
    await app.waitFor((e) => {
      const b = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim() === 'Lock (read only)');
      if (b) e.click(b);
      return !!b;
    }, [], { what: 'Lock in the tab menu' });
    await app.waitFor((e) => e.tabEl('Core R5').dataset.tabLocked === 'true', [], { what: 'the tab to show locked' });
    r5.clear();
    await app.run((e) => e.focusTerminal());
    await app.type('reload');
    await app.key('Enter');
    await sleep(400);
    assert.equal(r5.received.length, 0, `nothing reached the device, got ${JSON.stringify(r5.text())}`);
    const note = await app.run(() => [...document.querySelectorAll('[role="status"]')].map((x) => x.textContent).join('|'));
    assert.match(note, /This tab is locked/);

    await app.run((e) => {
      const b = [...document.querySelectorAll('[role="status"] button')].find((x) => x.textContent.trim() === 'Unlock');
      return e.click(b);
    });
    await app.waitFor((e) => e.tabEl('Core R5').dataset.tabLocked === 'false', [], { what: 'the tab to unlock' });
    await app.run((e) => e.focusTerminal());
    await app.type('show users');
    await app.key('Enter');
    await r5.waitForLine('show users');
  }],
];
