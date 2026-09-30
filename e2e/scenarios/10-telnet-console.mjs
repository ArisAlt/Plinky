// A router console the way GNS3 opens one: `plinky --telnet host port
// --title R1`, to a console that prints nothing until it is sent Enter.
//
// Where a test says "like PuTTY", the expected bytes are PuTTY's defaults
// (Keyboard panel: Backspace is Control-?, Home/End "Standard", function
// keys "ESC[n~"), because that is what the devices on the other end, and
// the people using them, are used to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startConsole, waitUntil } from '../lib/fixtures.mjs';

export const title = 'Telnet console, opened the way GNS3 opens it';

export async function setup() {
  const r1 = await startConsole({ name: 'R1' });
  return {
    args: ['--telnet', '127.0.0.1', String(r1.port), '--title', 'R1'],
    state: { r1 },
    cleanup: () => r1.stop(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// Sends a line and waits until the console has accepted it.
async function command(app, r1, text) {
  await app.type(text);
  await app.key('Enter');
  await r1.waitForLine(text);
}

// The bytes the console receives for one key press.
async function bytesFor(app, r1, key) {
  await app.run((e) => e.focusTerminal());
  r1.clear();
  await app.key(key);
  await waitUntil(() => r1.received.length > 0, { what: `any bytes for ${key}`, timeoutMs: 2000 });
  await sleep(100); // the rest of an escape sequence
  const got = Buffer.from(r1.received);
  // Leave the console at an empty prompt for the next test.
  await app.key('Ctrl+C');
  await r1.waitForBytes('\x03');
  return got;
}

const setClipboard = (app, text) => app.invoke('write_clipboard_text', { text });
const getClipboard = (app) => app.invoke('read_clipboard_text');
const pasteDialogOpen = (app) => app.run(() => !!document.querySelector('[aria-labelledby="paste-title"]'));

// Multi-line pastes ask first; the paste window opens once the clipboard
// has been read, so wait for it, then press Enter (Paste has the focus).
async function confirmPaste(app) {
  await app.waitFor(() => !!document.querySelector('[aria-labelledby="paste-title"]'), [], { what: 'the paste window' });
  await app.key('Enter');
  await app.waitFor(() => !document.querySelector('[aria-labelledby="paste-title"]'), [], { what: 'the paste window to close' });
}

export const tests = [
  ['a console that prints nothing is ready as soon as it connects', async ({ app, r1 }) => {
    // PuTTY shows a silent console at once. Plinky once waited for output
    // that never came: the tab spun and the banner stayed for 10 s.
    const started = Date.now();
    await app.waitForTab('R1', 'live', { timeoutMs: 3000 });
    const took = Date.now() - started;
    assert.equal(r1.connections, 1, 'one connection to the console');
    assert.ok(took < 2000, `the tab took ${took} ms to be ready`);
    assert.doesNotMatch(await app.screenText(), /connecting/i, 'no "connecting" banner on screen');
  }],

  ['Enter wakes the console and its prompt shows', async ({ app, r1 }) => {
    await app.run((e) => e.focusTerminal());
    await app.key('Enter');
    await r1.waitForBytes('\r');
    await app.waitForScreen('R1>');
  }],

  ['what is typed reaches the console once and is echoed once', async ({ app, r1 }) => {
    await command(app, r1, 'show version');
    await app.waitForScreen('you typed: show version');
    const screen = await app.screen();
    const echoed = screen.filter((l) => l.includes('R1>show version'));
    assert.equal(echoed.length, 1, `the command line appears once, not double-echoed:\n${screen.join('\n')}`);
  }],

  ['Enter ends the line with a telnet newline and nothing else', async ({ app, r1 }) => {
    // PuTTY sends CR LF ("Return key sends Telnet New Line"); plink sends
    // CR NUL. Both are a telnet newline. A bare LF or a doubled line end
    // would run the command twice on a router.
    r1.clear();
    await command(app, r1, 'ping 192.0.2.1');
    await sleep(150);
    const tail = r1.text().slice('ping 192.0.2.1'.length);
    assert.ok(tail === '\r\n' || tail === '\r\0', `line end was ${JSON.stringify(tail)}`);
    assert.deepEqual(r1.lines, ['ping 192.0.2.1']);
  }],

  ['Backspace sends DEL (0x7f), like PuTTY', async ({ app, r1 }) => {
    assert.equal(hex(await bytesFor(app, r1, 'Backspace')), '7f');
  }],

  ['Backspace corrects a typo before the router sees the line', async ({ app, r1 }) => {
    r1.clear();
    await app.type('shw');
    await app.key('Backspace');
    await app.type('ow clock');
    await app.key('Enter');
    await r1.waitForLine('show clock');
  }],

  ['Ctrl+C reaches the router instead of copying', async ({ app, r1 }) => {
    assert.equal(hex(await bytesFor(app, r1, 'Ctrl+C')), '03');
  }],

  ['the arrow keys send what PuTTY sends', async ({ app, r1 }) => {
    // IOS recalls command history with the up arrow.
    assert.equal(hex(await bytesFor(app, r1, 'Up')), hex(Buffer.from('\x1b[A')));
    assert.equal(hex(await bytesFor(app, r1, 'Left')), hex(Buffer.from('\x1b[D')));
  }],

  ['Home and End send what PuTTY sends', async ({ app, r1 }) => {
    // PuTTY's default ("Standard"): ESC [1~ and ESC [4~.
    const home = await bytesFor(app, r1, 'Home');
    const end = await bytesFor(app, r1, 'End');
    assert.deepEqual(
      { home: JSON.stringify(home.toString()), end: JSON.stringify(end.toString()) },
      { home: JSON.stringify('\x1b[1~'), end: JSON.stringify('\x1b[4~') },
    );
  }],

  ['F1 and Delete send what PuTTY sends', async ({ app, r1 }) => {
    // PuTTY's default function keys ("ESC[n~"): F1 is ESC [11~.
    const f1 = await bytesFor(app, r1, 'F1');
    const del = await bytesFor(app, r1, 'Delete');
    assert.deepEqual(
      { f1: JSON.stringify(f1.toString()), del: JSON.stringify(del.toString()) },
      { f1: JSON.stringify('\x1b[11~'), del: JSON.stringify('\x1b[3~') },
    );
  }],

  ['Ctrl+Z reaches the router (Cisco: leave configuration mode)', async ({ app, r1 }) => {
    assert.equal(hex(await bytesFor(app, r1, 'Ctrl+Z')), '1a');
  }],

  ['Ctrl+Shift+6 sends Ctrl+^ (Cisco: abort a ping or traceroute), like PuTTY', async ({ app, r1 }) => {
    // The Cisco escape sequence is Ctrl+Shift+6 then x. PuTTY sends 0x1e.
    assert.equal(hex(await bytesFor(app, r1, 'Ctrl+Shift+6')), '1e');
  }],

  ['Alt+B sends ESC b, like PuTTY', async ({ app, r1 }) => {
    // Alt is Meta: Emacs keys in bash and the like, word left.
    assert.equal(hex(await bytesFor(app, r1, 'Alt+B')), '1b 62');
  }],

  ['Ctrl+Shift+V pastes one line from another program without asking', async ({ app, r1 }) => {
    await setClipboard(app, 'show ip interface brief');
    r1.clear();
    await app.run((e) => e.focusTerminal());
    await app.key('Ctrl+Shift+V');
    await r1.waitForBytes('show ip interface brief');
    assert.equal(await pasteDialogOpen(app), false, 'no paste window for one line');
    await app.key('Enter');
    await r1.waitForLine('show ip interface brief');
  }],

  ['Shift+Insert pastes too, like PuTTY', async ({ app, r1 }) => {
    await setClipboard(app, 'show clock');
    r1.clear();
    await app.run((e) => e.focusTerminal());
    await app.key('Shift+Insert');
    await r1.waitForBytes('show clock');
    await app.key('Enter');
    await r1.waitForLine('show clock');
  }],

  ['a multi-line paste asks first, and Escape sends nothing', async ({ app, r1 }) => {
    await setClipboard(app, 'conf t\ninterface Gi0/1\n');
    r1.clear();
    await app.run((e) => e.focusTerminal());
    await app.key('Ctrl+Shift+V');
    await app.waitFor(() => !!document.querySelector('[aria-labelledby="paste-title"]'), [], { what: 'the paste window' });
    await app.key('Escape');
    await app.waitFor(() => !document.querySelector('[aria-labelledby="paste-title"]'), [], { what: 'the paste window to close' });
    await sleep(300);
    assert.equal(r1.received.length, 0, `nothing reaches the router, got ${JSON.stringify(r1.text())}`);
  }],

  ['a confirmed multi-line paste arrives as lines, one Enter each', async ({ app, r1 }) => {
    // Text copied on Windows ends its lines in CR LF. Each line must reach
    // the router as one line: a CR and an LF both sent would be two Enters.
    await setClipboard(app, 'conf t\r\nhostname R1-e2e\r\nend\r\n');
    r1.clear();
    await app.run((e) => e.focusTerminal());
    await app.key('Ctrl+Shift+V');
    await app.waitFor(() => !!document.querySelector('[aria-labelledby="paste-title"]'), [], { what: 'the paste window' });
    await app.key('Enter');
    await r1.waitForLine('end');
    await sleep(200);
    assert.deepEqual(r1.lines, ['conf t', 'hostname R1-e2e', 'end']);
  }],

  ['Paste from the right-click menu sends the same bytes as Ctrl+Shift+V', async ({ app, r1 }) => {
    // Two ways to paste the same text must send the same thing.
    const text = 'show run\nshow ver\n';
    await setClipboard(app, text);
    r1.clear();
    await app.run((e) => e.focusTerminal());
    await app.key('Ctrl+Shift+V');
    await confirmPaste(app);
    await r1.waitForLine('show ver');
    await sleep(200);
    const viaKeys = Buffer.from(r1.received);

    r1.clear();
    await app.run((e) => {
      const screenEl = [...document.querySelectorAll('.xterm')].find(e.visible).querySelector('.xterm-screen');
      return e.rightClick(screenEl);
    });
    const paste = await app.waitFor(() => {
      const item = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Paste') && window.__e2e.visible(b));
      if (item) window.__e2e.click(item);
      return !!item;
    }, [], { what: 'Paste in the right-click menu' });
    assert.ok(paste);
    await confirmPaste(app);
    await waitUntil(() => r1.received.length >= viaKeys.length, { what: 'the menu paste to arrive', timeoutMs: 3000 }).catch(() => {});
    await sleep(200);
    assert.equal(JSON.stringify(r1.text()), JSON.stringify(viaKeys.toString('latin1')));
  }],

  ['selecting text copies it, like PuTTY', async ({ app, r1 }) => {
    await command(app, r1, 'show inventory');
    await app.waitForScreen('you typed: show inventory');
    await setClipboard(app, 'before');
    const row = await app.run((e) => e.screen().findIndex((l) => l.startsWith('you typed: show inventory')));
    await app.run((e, r) => e.selectCells(0, r, 9, r), row);
    const copied = await waitUntil(async () => {
      const c = await getClipboard(app);
      return c !== 'before' ? c : null;
    }, { what: 'the selection to reach the clipboard', timeoutMs: 2000 });
    assert.equal(copied, 'you typed:');
  }],

  ['right-click opens the menu, and pastes once Settings says so', async ({ app, r1 }) => {
    // Plinky's default is the menu; "Paste Clipboard (PuTTY)" in Settings
    // makes a right click paste, as PuTTY on Windows does.
    const surface = () => app.run((e) => e.rightClick([...document.querySelectorAll('.xterm')].find(e.visible).querySelector('.xterm-screen')));
    const clickText = (text) => app.waitFor((e, t) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(t) && e.visible(x));
      if (b) e.click(b);
      return !!b;
    }, [text], { what: `"${text}"` });
    const setRightClick = async (choice) => {
      await app.run((e) => e.click(document.querySelector('[aria-label="Settings"]')));
      await clickText(choice);
      await app.run((e) => e.click(document.querySelector('[aria-label="Close settings"]')));
      await app.waitFor(() => !document.querySelector('[aria-label="Close settings"]'), [], { what: 'Settings to close' });
    };

    await setClipboard(app, 'show arp');
    r1.clear();
    await surface();
    await app.waitFor((e) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Duplicate Session' && e.visible(b)), [], { what: 'the menu' });
    await app.run((e) => e.dismissAll());
    await sleep(300);
    assert.equal(r1.received.length, 0, 'the menu pastes nothing by itself');

    await setRightClick('Paste Clipboard (PuTTY)');
    try {
      await surface();
      await r1.waitForBytes('show arp', { timeoutMs: 2000 });
      const menu = await app.run((e) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Duplicate Session' && e.visible(b)));
      assert.equal(menu, false, 'no menu when right click pastes');
    } finally {
      await app.key('Ctrl+C');
      await setRightClick('Context Menu');
    }
  }],

  ['a long listing arrives complete and in order', async ({ app, r1 }) => {
    const n = 20000;
    const started = Date.now();
    await command(app, r1, `show big ${n}`);
    await app.waitForScreen(`END-OF-OUTPUT ${n}`, { timeoutMs: 20000 });
    const took = Date.now() - started;
    const screen = await app.screen();
    const numbers = screen.map((l) => l.match(/^line (\d+) of/)?.[1]).filter(Boolean).map(Number);
    assert.ok(numbers.length > 5, 'numbered lines on screen');
    numbers.forEach((v, i) => i && assert.equal(v, numbers[i - 1] + 1, `line ${v} follows ${numbers[i - 1]}`));
    assert.equal(numbers.at(-1), n, 'the last line is the last one sent');
    assert.ok(took < 8000, `${n} lines took ${took} ms to show`);
  }, { timeoutMs: 40000 }],

  ['Shift+PageUp scrolls back through the output, and sends nothing', async ({ app, r1 }) => {
    const before = await app.screen();
    r1.clear();
    await app.run((e) => e.focusTerminal());
    await app.key('Shift+PageUp');
    await sleep(200);
    const after = await app.screen();
    assert.notDeepEqual(after, before, 'the screen shows earlier output');
    const first = (lines) => Number(lines.find((l) => /^line \d+/.test(l))?.match(/^line (\d+)/)[1]);
    assert.ok(first(after) < first(before), `scrolled back: first line ${first(after)} < ${first(before)}`);
    assert.equal(r1.received.length, 0, 'the router got nothing');
    await app.key('Shift+PageDown');
    await app.key('Shift+PageDown');
    await app.key('Shift+PageDown');
    await app.type('x');
    await r1.waitForBytes('x');
    await app.waitForScreen(/R1>x$/m);
    await app.key('Ctrl+C');
  }],

  ['Greek text shows as Greek, both ways', async ({ app, r1 }) => {
    await command(app, r1, 'show utf8');
    await app.waitForScreen('Καλημέρα κόσμε ✓ — ψ');
    r1.clear();
    await app.type('ψ');
    await r1.waitForBytes(Buffer.from('ψ', 'utf8'));
    await app.key('Ctrl+C');
  }],

  ['the router is told the window size, and told again when it changes', async ({ app, r1 }) => {
    await waitUntil(() => r1.naws.length > 0, { what: 'a window size from the client', timeoutMs: 3000 });
    const size = await app.run((e) => e.termSize());
    const told = r1.naws.at(-1);
    assert.deepEqual(told, { cols: size.cols, rows: size.rows }, 'the size the router was told is the size on screen');

    // Widen the session list: the terminal gets narrower.
    const before = r1.naws.length;
    await app.run(() => {
      const handle = document.querySelector('[role="separator"]');
      if (!handle) throw new Error('no sidebar handle');
      handle.focus();
      for (let i = 0; i < 6; i++) handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      return true;
    });
    await waitUntil(() => r1.naws.length > before, { what: 'a new window size after the resize', timeoutMs: 3000 });
    const after = await app.run((e) => e.termSize());
    assert.deepEqual(r1.naws.at(-1), { cols: after.cols, rows: after.rows });
    assert.ok(after.cols < size.cols, 'the terminal did get narrower');
  }],

  ['Ctrl+Tab to another tab and back keeps the console ready', async ({ app, r1, ctx }) => {
    // A second tab to switch to: a duplicate of this console.
    await app.run((e) => e.rightClick([...document.querySelectorAll('.xterm')].find(e.visible).querySelector('.xterm-screen')));
    await app.waitFor(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Duplicate Session' && window.__e2e.visible(x));
      if (b) window.__e2e.click(b);
      return !!b;
    }, [], { what: 'Duplicate Session in the menu' });
    await waitUntil(() => r1.connections === 2, { what: 'the duplicate to connect', timeoutMs: 3000 });
    await app.waitFor((e) => e.tabs().length === 2 && e.tabs().every((t) => t.status === 'live'), [], { what: 'two live tabs', timeoutMs: 3000 });

    await app.run((e) => e.focusTerminal());
    await app.key('Ctrl+Tab');
    await sleep(300);
    await app.key('Ctrl+Tab');
    await sleep(300);
    const tabs = await app.tabs();
    assert.deepEqual(tabs.map((t) => t.status), ['live', 'live']);
    void ctx;
  }],

  ['Ctrl+Shift+W asks before closing a connected tab', async ({ app, r1 }) => {
    const open = r1.open;
    await app.run((e) => e.focusTerminal());
    await app.key('Ctrl+Shift+W');
    await app.waitFor((e) => e.dialogs().some((d) => /close/i.test(d)), [], { what: 'a close confirmation' });
    await app.key('Escape');
    await sleep(300);
    assert.equal((await app.tabs()).length, 2, 'Escape keeps the tab');
    assert.equal(r1.open, open, 'and its connection');

    await app.run((e) => e.focusTerminal());
    await app.key('Ctrl+Shift+W');
    await app.waitFor(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Close tab');
      if (b) window.__e2e.click(b);
      return !!b;
    }, [], { what: 'the Close tab button' });
    await app.waitFor((e) => e.tabs().length === 1, [], { what: 'the tab to close' });
    await waitUntil(() => r1.open === open - 1, { what: 'the connection to close', timeoutMs: 3000 });
  }],

  ['when the router hangs up the tab says so at once, and Reconnect works', async ({ app, r1 }) => {
    const before = r1.connections;
    r1.hangUp();
    await app.waitForTab('R1', 'disconnected', { timeoutMs: 3000 });
    await app.waitFor(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Reconnect' && window.__e2e.visible(x));
      if (b) window.__e2e.click(b);
      return !!b;
    }, [], { what: 'a Reconnect button' });
    await waitUntil(() => r1.connections === before + 1, { what: 'a new connection', timeoutMs: 5000 });
    await app.waitForTab('R1', 'live', { timeoutMs: 3000 });
  }],

  ['a Python script runs on the session: it types, reads the reply, and its notes show', async ({ app, r1, ctx }) => {
    // Run Script (scripts.rs): the script's stdout goes to the device, the
    // device's output to its stdin, its stderr to the terminal.
    const script = path.join(ctx.home, 'clock.py');
    fs.writeFileSync(script, [
      'from plinky import session',
      'reply = session.command("show clock")',
      'session.log("got", reply.strip())',
      '',
    ].join('\n'));
    await app.waitForTab('R1', 'live', { timeoutMs: 5000 });
    r1.clear();
    // The page's own call, as the menu makes it once a file is picked.
    await app.run(async (e, file) => {
      const active = e.tabs().find((t) => t.active);
      const id = [...document.querySelectorAll('[data-tab-status]')].find((el) => el.dataset.tabActive === 'true')?.dataset.tabId;
      return window.__TAURI_INTERNALS__.invoke('run_script', { sessionId: id, sessionName: active.title, path: file });
    }, script);
    await r1.waitForLine('show clock', { timeoutMs: 8000 });
    await app.waitForScreen('[script] got you typed: show clock', { timeoutMs: 8000 });
    await app.waitForScreen('[script finished]', { timeoutMs: 8000 });
  }, { timeoutMs: 30000 }],
];
