// TEMPORARY (branch ci/e2e-windows): what happens to Ctrl+Z on Windows.
// After the Ctrl+Z test nothing typed reached the router any more.
import { execFileSync } from 'node:child_process';
import { startConsole, waitUntil } from '../lib/fixtures.mjs';

export const title = 'DIAG: Ctrl+Z on Windows';

export async function setup() {
  if (process.platform !== 'win32') return { skip: 'Windows diagnostics' };
  const consoles = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => startConsole({ name: n })));
  return {
    env: { THYRION_DEBUG_CONSOLE: '1' },
    args: consoles.flatMap((c) => ['--telnet', '127.0.0.1', String(c.port), '--title', c.name]),
    state: { consoles },
    cleanup: () => Promise.all(consoles.map((c) => c.stop())),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plinks = () => {
  try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq plink.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).trim().split(/\r?\n/).length; } catch { return -1; }
};
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

async function probe(app, con, label, send) {
  await app.waitFor((e, t) => { const el = e.tabEl(t); if (el) e.click(el); return el?.dataset.tabActive === 'true'; }, [con.name]);
  await sleep(300);
  const id = await app.run((e, t) => e.tabEl(t).dataset.tabId, con.name);
  await app.run((e) => e.focusTerminal());
  con.clear();
  const before = plinks();
  await send(app, id);
  await sleep(800);
  const afterZ = hex(con.received);
  con.clear();
  await app.type('x');
  await sleep(800);
  const after = hex(con.received);
  console.log(`      DIAG ${label}: after send [${afterZ}] | then 'x' -> [${after}] | plink.exe ${before} -> ${plinks()}`);
}

export const tests = [
  ['report', async ({ app, consoles }) => {
    for (const c of consoles) await app.waitForTab(c.name, 'live', { timeoutMs: 10000 });
    await probe(app, consoles[0], 'key Ctrl+Z', async (a) => a.key('Ctrl+Z'));
    await probe(app, consoles[1], "write 'a'+^Z", async (a, id) => a.invoke('write_terminal_input', { sessionId: id, data: [0x61, 0x1a] }));
    await probe(app, consoles[2], 'write ^Z alone', async (a, id) => a.invoke('write_terminal_input', { sessionId: id, data: [0x1a] }));
    await probe(app, consoles[3], 'key Ctrl+Shift+6', async (a) => a.key('Ctrl+Shift+6'));
    await probe(app, consoles[4], "'b', pause, then ^Z alone", async (a, id) => {
      await a.invoke('write_terminal_input', { sessionId: id, data: [0x62] });
      await sleep(700);
      await a.invoke('write_terminal_input', { sessionId: id, data: [0x1a] });
    });
    const fs = await import('node:fs');
    console.log(fs.readFileSync(app.log, 'utf8').split(/\r?\n/).filter((l) => l.includes('console-mode')).map((l) => `      ${l}`).join('\n'));
  }, { timeoutMs: 60000 }],
];
