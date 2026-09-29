// Things the app connects to during a run: stand-in router consoles that
// speak telnet and record every byte they receive, and a private sshd. They
// listen on 127.0.0.1 only and live as long as the run.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const ECHO = 1, SGA = 3, NAWS = 31;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(check, { timeoutMs = 5000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * A router console on a telnet port, the way GNS3 serves one.
 *
 * `negotiate: true` behaves like IOS behind GNS3's console: it offers
 * WILL ECHO and WILL SUPPRESS-GO-AHEAD and asks for the window size, then
 * echoes what it is sent and edits the line itself. `negotiate: false` is a
 * console server that negotiates nothing (ser2net and similar), so the
 * client echoes and edits locally.
 *
 * Nothing is printed on connect: a router sitting at its prompt prints
 * nothing until it is sent Enter.
 */
export async function startConsole({ name = 'R1', negotiate = true } = {}) {
  const con = {
    name,
    received: Buffer.alloc(0), // data bytes, telnet commands removed
    commands: [],              // [verb, option] the client sent
    naws: [],                  // window sizes the client reported
    lines: [],                 // lines the console accepted
    connections: 0,
    open: 0,
    sockets: new Set(),
  };
  const prompt = `${name}>`;

  const handle = (sock) => {
    con.connections++;
    con.open++;
    con.sockets.add(sock);
    sock.on('close', () => { con.open--; con.sockets.delete(sock); });
    sock.on('error', () => {});
    if (negotiate) sock.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, NAWS]));

    let line = '';
    let lastWasCr = false;
    let state = 'data';
    let verb = 0;
    let sb = [];
    const say = (s) => sock.write(Buffer.from(s, 'utf8'));

    const accept = (text) => {
      con.lines.push(text);
      const cmd = text.trim();
      if (cmd === 'exit') { say('\r\n'); sock.end(); return; }
      let out = '';
      const big = cmd.match(/^show big (\d+)$/);
      if (big) {
        const n = Number(big[1]);
        const rows = [];
        for (let i = 1; i <= n; i++) rows.push(`line ${String(i).padStart(6, '0')} of ${n} ${'x'.repeat(40)}`);
        out = rows.join('\r\n') + `\r\nEND-OF-OUTPUT ${n}\r\n`;
      } else if (cmd === 'show utf8') {
        out = 'Καλημέρα κόσμε ✓ — ψ\r\n';
      } else if (cmd === 'show size') {
        const s = con.naws.at(-1);
        out = s ? `size ${s.cols}x${s.rows}\r\n` : 'size unknown\r\n';
      } else if (cmd) {
        out = `you typed: ${cmd}\r\n`;
      }
      say(`\r\n${out}${prompt}`);
    };

    const onData = (b) => {
      con.received = Buffer.concat([con.received, Buffer.from([b])]);
      if (b === 0x0d) {             // CR: end of line (CR LF or CR NUL follows)
        lastWasCr = true;
        const text = Buffer.from(line, 'latin1').toString('utf8');
        line = '';
        accept(text);
        return;
      }
      // CR LF, CR NUL and CR NUL LF are each one line end: a telnet server
      // reads CR NUL as CR (RFC 854), and a line ended CR LF is one Enter.
      if (b === 0x00 && lastWasCr) return;
      if (b === 0x0a && lastWasCr) { lastWasCr = false; return; }
      lastWasCr = false;
      if (b === 0x0a) {             // a bare LF also ends a line
        const text = Buffer.from(line, 'latin1').toString('utf8');
        line = '';
        accept(text);
        return;
      }
      if (b === 0x03) { line = ''; say(`^C\r\n${prompt}`); return; }
      if (b === 0x7f || b === 0x08) {
        if (line.length) {
          // Remove one UTF-8 character, not one byte.
          const chars = [...Buffer.from(line, 'latin1').toString('utf8')];
          chars.pop();
          line = Buffer.from(chars.join(''), 'utf8').toString('latin1');
          if (negotiate) say('\b \b');
        }
        return;
      }
      if (b === 0x1b || b < 0x20) return; // keys the stand-in does not edit with
      line += String.fromCharCode(b);
      if (negotiate) sock.write(Buffer.from([b]));
    };

    sock.on('data', (chunk) => {
      for (const b of chunk) {
        if (state === 'data') {
          if (b === IAC) state = 'iac';
          else onData(b);
        } else if (state === 'iac') {
          if (b === IAC) { onData(IAC); state = 'data'; }
          else if (b === SB) { state = 'sb'; sb = []; }
          else if (b === WILL || b === WONT || b === DO || b === DONT) { verb = b; state = 'opt'; }
          else state = 'data';
        } else if (state === 'opt') {
          con.commands.push([{ [WILL]: 'WILL', [WONT]: 'WONT', [DO]: 'DO', [DONT]: 'DONT' }[verb], b]);
          state = 'data';
        } else if (state === 'sb') {
          if (b === IAC) state = 'sb-iac';
          else sb.push(b);
        } else if (state === 'sb-iac') {
          if (b === SE) {
            if (sb[0] === NAWS && sb.length >= 5) {
              con.naws.push({ cols: (sb[1] << 8) | sb[2], rows: (sb[3] << 8) | sb[4] });
            }
            state = 'data';
          } else { sb.push(b); state = 'sb'; }
        }
      }
    });
  };

  const server = net.createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  con.port = server.address().port;

  con.text = () => con.received.toString('latin1');
  con.clear = () => { con.received = Buffer.alloc(0); con.lines = []; };
  con.waitForBytes = (needle, opts = {}) => {
    const want = Buffer.isBuffer(needle) ? needle : Buffer.from(needle, 'utf8');
    return waitUntil(() => con.received.includes(want), { what: `${name} to receive ${JSON.stringify(want.toString('latin1'))}`, ...opts });
  };
  con.waitForLine = (text, opts = {}) =>
    waitUntil(() => con.lines.includes(text), { what: `${name} to receive the line ${JSON.stringify(text)}`, ...opts });
  con.hangUp = () => { for (const s of con.sockets) s.destroy(); };
  con.stop = () => new Promise((r) => { con.hangUp(); server.close(() => r()); });
  return con;
}

/**
 * A private sshd on a free port, logging in the current user with a key.
 * The shell it gives is a plain bash with a fixed prompt: the user's own
 * shell and dotfiles are not run.
 */
export async function startSshd(dir) {
  const sshd = ['/usr/bin/sshd', '/usr/sbin/sshd', '/sbin/sshd'].find((p) => fs.existsSync(p));
  if (!sshd) return null;
  for (const tool of ['ssh-keygen', 'puttygen']) {
    try { execFileSync(tool, ['--help'], { stdio: 'ignore' }); } catch (e) { if (e.code === 'ENOENT') return null; }
  }
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', f('host_key')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', f('client_key')]);
  fs.copyFileSync(f('client_key.pub'), f('authorized_keys'));
  execFileSync('puttygen', [f('client_key'), '-o', f('client_key.ppk'), '-O', 'private']);
  const fingerprint = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', f('host_key.pub')])
    .toString().split(' ')[1];

  const port = await freePort();
  fs.writeFileSync(f('sshd_config'), [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${f('host_key')}`,
    `AuthorizedKeysFile ${f('authorized_keys')}`,
    `PidFile ${f('sshd.pid')}`,
    'StrictModes no',
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'PrintMotd no',
    'PrintLastLog no',
    // A known shell and prompt, whatever the user's login shell is.
    `ForceCommand env PS1='e2e$ ' HISTFILE=/dev/null /bin/bash --noprofile --norc -i`,
    '',
  ].join('\n'));
  const child = spawn(sshd, ['-D', '-e', '-f', f('sshd_config')], { stdio: ['ignore', 'ignore', fs.openSync(f('sshd.log'), 'a')] });
  await waitUntil(() => new Promise((r) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); });
    s.on('error', () => r(false));
  }), { what: 'sshd to listen', timeoutMs: 5000 });
  return {
    port,
    fingerprint,
    ppk: f('client_key.ppk'),
    log: () => fs.readFileSync(f('sshd.log'), 'utf8'),
    stop: () => { child.kill(); },
  };
}

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Writes a saved session the way PuTTY on Unix stores one. */
export function writePuttySession(home, name, settings) {
  const dir = path.join(home, '.putty', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = encodeURIComponent(name).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  fs.writeFileSync(path.join(dir, file), Object.entries(settings).map(([k, v]) => `${k}=${v}\n`).join(''));
}

/**
 * A router on a serial line: socat joins two pseudo-terminals, the app opens
 * one as its serial device, and this plays the router on the other. A router
 * console echoes what it is sent and prints nothing until Enter.
 */
export async function startSerialDevice(dir, { name = 'R9' } = {}) {
  try { execFileSync('socat', ['-V'], { stdio: 'ignore' }); } catch { return null; }
  fs.mkdirSync(dir, { recursive: true });
  const appSide = path.join(dir, 'ttyE2E0');
  const deviceSide = path.join(dir, 'ttyE2E1');
  const socat = spawn('socat', [`pty,raw,echo=0,link=${appSide}`, `pty,raw,echo=0,link=${deviceSide}`], { stdio: 'ignore' });
  await waitUntil(() => fs.existsSync(appSide) && fs.existsSync(deviceSide), { what: 'socat ptys', timeoutMs: 5000 });

  const dev = { name, path: appSide, received: Buffer.alloc(0), lines: [] };
  const fd = fs.openSync(deviceSide, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
  const say = (s) => { try { fs.writeSync(fd, Buffer.from(s, 'utf8')); } catch { /* line gone */ } };
  let line = '';
  const stream = fs.createReadStream(null, { fd, autoClose: false });
  stream.on('error', () => {});
  stream.on('data', (chunk) => {
    for (const b of chunk) {
      dev.received = Buffer.concat([dev.received, Buffer.from([b])]);
      if (b === 0x0d || b === 0x0a) {
        if (b === 0x0a && dev.lastWasCr) { dev.lastWasCr = false; continue; }
        dev.lastWasCr = b === 0x0d;
        dev.lines.push(line);
        say(`\r\n${line ? `you typed: ${line}\r\n` : ''}${name}>`);
        line = '';
      } else if (b === 0x7f || b === 0x08) {
        if (line) { line = line.slice(0, -1); say('\b \b'); }
      } else if (b >= 0x20) {
        line += String.fromCharCode(b);
        say(String.fromCharCode(b));
      }
    }
  });
  dev.clear = () => { dev.received = Buffer.alloc(0); dev.lines = []; };
  dev.waitForLine = (text, opts = {}) =>
    waitUntil(() => dev.lines.includes(text), { what: `${name} to receive the line ${JSON.stringify(text)}`, ...opts });
  dev.waitForBytes = (s, opts = {}) =>
    waitUntil(() => dev.received.includes(Buffer.from(s)), { what: `${name} to receive ${JSON.stringify(s)}`, ...opts });
  /** The USB adapter pulled out: the line goes away. */
  dev.unplug = () => { stream.destroy(); try { fs.closeSync(fd); } catch { /* closed */ } socat.kill(); };
  dev.stop = dev.unplug;
  return dev;
}
