// Console servers that negotiate nothing (ser2net and similar), over telnet
// and over raw TCP. With no echo from the far end, PuTTY echoes and edits
// the line itself and sends it on Enter, ending it with CR LF.
import assert from 'node:assert/strict';
import { startConsole, waitUntil } from '../lib/fixtures.mjs';

export const title = 'Console servers that negotiate nothing (telnet and raw)';

export async function setup() {
  const telnet = await startConsole({ name: 'SW1', negotiate: false });
  const raw = await startConsole({ name: 'SW2', negotiate: false });
  return {
    args: [
      '--telnet', '127.0.0.1', String(telnet.port), '--title', 'SW1',
      '--raw', '127.0.0.1', String(raw.port), '--title', 'SW2',
    ],
    state: { telnet, raw },
    cleanup: async () => { await telnet.stop(); await raw.stop(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function showTab(app, title) {
  await app.waitFor((e, t) => {
    const el = e.tabEl(t);
    if (el && el.dataset.tabActive !== 'true') e.click(el);
    return el?.dataset.tabActive === 'true';
  }, [title], { what: `tab ${title} in front` });
  await sleep(150);
  await app.run((e) => e.focusTerminal());
}


const lineTests = (label, stateKey, title) => [
  [`${label}: both tabs open and are ready`, async ({ app }) => {
    await app.waitForTab(title, 'live', { timeoutMs: 5000 });
  }],

  [`${label}: what is typed shows once, and the line ends in CR LF like PuTTY`, async ({ app, ...s }) => {
    const con = s[stateKey];
    await showTab(app, title);
    con.clear();
    await app.type('show vlan');
    await sleep(200);
    const screen = (await app.screen()).join('\n');
    assert.equal((screen.match(/show vlan/g) ?? []).length, 1, `typed text shows once:\n${screen}`);
    await app.key('Enter');
    await con.waitForLine('show vlan');
    await sleep(150);
    // PuTTY ends the line CR LF. plink writes every CR as CR NUL on telnet
    // (RFC 854), which the server reads back as CR: the same CR LF.
    const want = stateKey === 'telnet' ? 'show vlan\r\0\n' : 'show vlan\r\n';
    assert.equal(JSON.stringify(con.text()), JSON.stringify(want));
  }],

  [`${label}: Backspace edits the line before it is sent`, async ({ app, ...s }) => {
    const con = s[stateKey];
    await showTab(app, title);
    con.clear();
    await app.type('shw');
    await app.key('Backspace');
    await app.type('ow clock');
    await app.key('Enter');
    await waitUntil(() => con.lines.length > 0, { what: 'a line', timeoutMs: 3000 });
    await sleep(150);
    assert.deepEqual(con.lines, ['show clock'], `the router received ${JSON.stringify(con.text())}`);
  }],

  [`${label}: the echo looks like PuTTY's: Backspace erases, no ^? ^M ^J or ^[[A`, async ({ app, ...s }) => {
    // The pty echoed control keys as ^X: "shw^?ow clock^M^J", and Up as
    // ^[[A. Plinky echoes these consoles itself now, as PuTTY does.
    const con = s[stateKey];
    await showTab(app, title);
    con.clear();
    await app.type('shw');
    await app.key('Backspace');
    await app.type('ow ip');
    await app.key('Up');
    await sleep(200);
    const typed = (await app.screen()).filter((l) => l.trim()).at(-1);
    assert.match(typed, />show ip$/, 'Backspace erased the w and Up showed nothing');
    await app.key('Enter');
    // Up went to the console as typed (its line holds the arrow's "[A").
    await waitUntil(() => con.lines.length > 0, { what: 'a line', timeoutMs: 3000 });
    assert.ok(con.lines[0].startsWith('show ip'), JSON.stringify(con.lines));
    await app.waitForScreen('you typed: show ip');
    const screen = (await app.screen()).join('\n');
    assert.doesNotMatch(screen, /\^[?MJ[]/, `no control characters echoed as ^X:\n${screen}`);
  }],
];

export const tests = [
  ...lineTests('telnet', 'telnet', 'SW1'),
  ...lineTests('raw', 'raw', 'SW2'),
];
