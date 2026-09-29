// A saved serial session, to a router on the other end of the line.
import assert from 'node:assert/strict';
import path from 'node:path';
import { startSerialDevice, writePuttySession } from '../lib/fixtures.mjs';

export const title = 'Serial console, from a saved session';

export async function setup({ home, runDir }) {
  const dev = await startSerialDevice(path.join(runDir, 'serial'));
  if (!dev) return { skip: 'needs socat' };
  writePuttySession(home, 'Console Cable', {
    Protocol: 'serial', SerialLine: dev.path, SerialSpeed: 9600,
    SerialDataBits: 8, SerialStopHalfbits: 2, SerialParity: 0, SerialFlowControl: 0,
  });
  return { state: { dev }, cleanup: () => dev.stop() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const tests = [
  ['a serial session opens ready, though the router prints nothing', async ({ app }) => {
    await app.waitFor(() => !!document.querySelector('[data-session-row="Console Cable"]'), [], { what: 'the session in the list' });
    await app.run((e) => e.dblclick(document.querySelector('[data-session-row="Console Cable"]')));
    await app.waitForTab('Console Cable', 'live', { timeoutMs: 3000 });
  }],

  ['Enter sends CR, like PuTTY on a serial line, and the prompt shows', async ({ app, dev }) => {
    await app.run((e) => e.focusTerminal());
    dev.clear();
    await app.key('Enter');
    await dev.waitForBytes('\r');
    await sleep(150);
    assert.equal(JSON.stringify(dev.received.toString('latin1')), JSON.stringify('\r'));
    await app.waitForScreen('R9>');
  }],

  ['typing is echoed once, by the router', async ({ app, dev }) => {
    dev.clear();
    await app.type('show version');
    await app.key('Enter');
    await dev.waitForLine('show version');
    await app.waitForScreen('you typed: show version');
    const screen = await app.screen();
    assert.equal(screen.filter((l) => l.includes('R9>show version')).length, 1, screen.join('\n'));
  }],

  ['Backspace sends DEL (0x7f), like PuTTY', async ({ app, dev }) => {
    dev.clear();
    await app.key('Backspace');
    await sleep(150);
    assert.deepEqual([...dev.received], [0x7f]);
  }],

  ['pulling out the USB adapter shows the tab as disconnected', async ({ app, dev }) => {
    dev.unplug();
    await app.waitForTab('Console Cable', 'disconnected', { timeoutMs: 5000 });
  }],
];
