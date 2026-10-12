#!/usr/bin/env node
// Makes the README's pictures: the real app on a hidden screen, in front of
// a small invented lab (R1, R2, SW1, SW2 on 192.0.2.0/24 documentation
// addresses) so nothing in them is anyone's network.
//
//   node e2e/shots.mjs <outDir>      needs the test build: --build in run.mjs
//
// Writes workflow.png (session tree, a 2x2 grid of consoles) and
// sftp.png (a console beside the SFTP browser), plus the numbered frames of
// the GNS3 hand-over in <outDir>/gns3/ for assembling into a GIF.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDisplay } from './lib/display.mjs';
import { launchApp } from './lib/app.mjs';
import { startConsole, startSshd, writePuttySession } from './lib/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? 'docs/images');
const binary = path.resolve(here, '../target/debug/thyrion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const importAsync = (file, env) => new Promise((resolve, reject) => {
  execFile('import', ['-window', 'root', file], { env }, (e) => (e ? reject(e) : resolve()));
});
const W = 1920, H = 1080;

const IFACES = {
  R1: [['GigabitEthernet0/0', '192.0.2.1', 'up', 'up'], ['GigabitEthernet0/1', '198.51.100.1', 'up', 'up'], ['Loopback0', '203.0.113.1', 'up', 'up']],
  R2: [['GigabitEthernet0/0', '192.0.2.2', 'up', 'up'], ['GigabitEthernet0/1', '198.51.100.2', 'up', 'up'], ['Loopback0', '203.0.113.2', 'up', 'up']],
  SW1: [['Vlan10', '192.0.2.11', 'up', 'up'], ['Vlan20', '192.0.2.35', 'up', 'up'], ['GigabitEthernet0/24', 'unassigned', 'down', 'down']],
  SW2: [['Vlan10', '192.0.2.12', 'up', 'up'], ['Vlan20', '192.0.2.36', 'up', 'up'], ['GigabitEthernet0/24', 'unassigned', 'up', 'up']],
};

function replies(name) {
  return (cmd) => {
    if (/^(sh|show) ip int(erface)? br(ief)?$/.test(cmd)) {
      const rows = IFACES[name].map(([i, ip, s, p]) =>
        `${i.padEnd(22)}${ip.padEnd(15)}YES manual ${(s === 'down' ? 'admin down' : s).padEnd(11)}${p}`);
      return ['Interface             IP-Address     OK? Method Status     Protocol', ...rows].join('\r\n') + '\r\n';
    }
    if (/^(sh|show) ip ospf nei/.test(cmd)) {
      return ['Neighbor ID     Pri   State       Dead Time   Address         Interface',
        '203.0.113.2       1   FULL/DR     00:00:33    192.0.2.2       Gi0/0',
        '203.0.113.3       1   FULL/BDR    00:00:39    198.51.100.3    Gi0/1'].join('\r\n') + '\r\n';
    }
    if (/^(sh|show) ver/.test(cmd)) return `Cisco IOS Software, ${name} Software (C3725-ADVENTERPRISEK9-M), Version 12.4(25d)\r\n${name} uptime is 2 hours, 14 minutes\r\n`;
    if (/^(sh|show) vlan br/.test(cmd)) return ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- ----------------', '10   users                            active    Gi0/1, Gi0/2', '20   servers                          active    Gi0/3, Gi0/4'].join('\r\n') + '\r\n';
    if (/^ping /.test(cmd)) return 'Type escape sequence to abort.\r\nSending 5, 100-byte ICMP Echos to ' + cmd.split(' ')[1] + ', timeout is 2 seconds:\r\n!!!!!\r\nSuccess rate is 100 percent (5/5), round-trip min/avg/max = 4/6/9 ms\r\n';
    return `% Invalid input detected at '^' marker.\r\n`;
  };
}

// Types a command into the focused terminal at a human pace.
async function typeSlow(app, text) {
  for (const ch of text) { await app.type(ch); await sleep(35); }
  await app.key('Enter');
}

const shot = (display, file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('import', ['-window', 'root', file], { env: { ...process.env, ...display.env } });
};

async function main() {
  // Paths show in the file browser: plain names, not a temp folder's.
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thyrion-shots-'));
  const home = '/tmp/home/netops';
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const display = await startDisplay({ runDir, width: W, height: H });

  const names = ['R1', 'R2', 'SW1', 'SW2'];
  const consoles = Object.fromEntries(await Promise.all(names.map(async (n) =>
    [n, await startConsole({ name: n, mark: '#', replies: replies(n), port: 5001 + names.indexOf(n) })])));

  // The remote end of the file browser: the lab's config backups.
  const share = '/tmp/srv/backups';
  fs.rmSync(share, { recursive: true, force: true });
  fs.mkdirSync(path.join(share, 'configs'), { recursive: true });
  fs.mkdirSync(path.join(share, 'images'), { recursive: true });
  const config = (n) => [
    '!', `hostname ${n}`, '!', 'interface GigabitEthernet0/0', ` ip address ${IFACES[n][0][1]} 255.255.255.0`, ' no shutdown', '!',
    'router ospf 1', ' network 192.0.2.0 0.0.0.255 area 0', '!', 'line vty 0 4', ' transport input ssh', '!', 'end', '',
  ].join('\n');
  for (const n of names) fs.writeFileSync(path.join(share, 'configs', `${n}-running-config.txt`), config(n).repeat(40));
  fs.writeFileSync(path.join(share, 'images', 'c3725-adventerprisek9-mz.124-25d.bin'), Buffer.alloc(31 * 1024 * 1024, 1));
  fs.writeFileSync(path.join(share, 'README.txt'), 'Nightly config backups of the lab.\n');
  // The local side: the profile's home.
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  fs.writeFileSync(path.join(home, 'lab-topology.gns3'), '{}'.padEnd(18000));
  fs.writeFileSync(path.join(home, 'R1-new.cfg'), config('R1'));
  const sshd = await startSshd(path.join(runDir, 'sshd'), { sftp: true, prompt: 'root@backup:~/backups$ ', sftpDir: share, port: 2222 });
  if (!sshd) throw new Error('needs sshd, ssh-keygen and puttygen');

  const folders = { R1: 'Lab/Core', R2: 'Lab/Core', SW1: 'Lab/Access', SW2: 'Lab/Access' };
  for (const n of names) {
    writePuttySession(home, n, {
      HostName: '127.0.0.1', PortNumber: consoles[n].port, Protocol: 'telnet', PlinkyFolder: folders[n],
    });
  }
  writePuttySession(home, 'Backup server', {
    HostName: '127.0.0.1', PortNumber: sshd.port, Protocol: 'ssh', UserName: os.userInfo().username,
    PublicKeyFile: sshd.ppk, PlinkyFolder: 'Lab/Servers', SSHManualHostKeys: sshd.fingerprint,
  });
  for (const [n, h] of [['Edge firewall', '192.0.2.250'], ['Wi-Fi controller', '192.0.2.60']]) {
    writePuttySession(home, n, { HostName: h, PortNumber: 22, Protocol: 'ssh', UserName: 'admin' });
  }

  const app = await launchApp({ binary, display, home, env: { SHELL: '/bin/bash' }, log: path.join(runDir, 'app.log') });
  try {
    // Fixed window size for repeatable pictures.
    execFileSync('xdotool', ['search', '--onlyvisible', '--name', 'Thyrion', 'windowmove', '0', '0', 'windowsize', String(W), String(H)],
      { env: { ...process.env, ...display.env }, stdio: 'ignore' });
    await sleep(800);
    const env = { ...process.env, ...display.env };
    const openSession = async (name) => {
      await app.run((e, n) => e.dblclick(document.querySelector(`[data-session-row="${n}"]`)), name);
      await app.waitForTab(name, 'live', { timeoutMs: 10000 });
    };
    const showTab = (name) => app.run((e, n) => e.click(e.tabEl(n)), name);
    const run = async (cmd, until) => {
      await app.run((e) => e.focusTerminal());
      await typeSlow(app, cmd);
      if (until) await app.waitForScreen(until, { timeoutMs: 8000 });
    };

    // Four consoles, each with something on it.
    const work = {
      R1: ['show ip interface brief', 'show ip ospf neighbor'],
      R2: ['show ip interface brief', 'show ip ospf neighbor'],
      SW1: ['show vlan brief', 'show ip interface brief'],
      SW2: ['ping 192.0.2.1', 'show ip interface brief'],
    };
    for (const n of names) {
      await openSession(n);
      await app.run((e) => e.focusTerminal());
      await app.key('Enter');
      await app.waitForScreen(`${n}#`, { timeoutMs: 5000 });
      for (const c of work[n]) await run(c);
    }
    await showTab('R1');
    await sleep(500);
    await app.run(() => document.querySelector('[title="4-Terminal Cluster Grid (2x2)"]').click());
    await sleep(1500);
    await app.run(() => document.activeElement?.blur());
    await sleep(800);
    shot(display, path.join(out, 'workflow.png'));
    console.log('workflow.png');

    // A server beside its files.
    await app.run(() => document.querySelector('[title="Single Terminal View"]').click());
    await openSession('Backup server');
    await app.waitForScreen('backups$', { timeoutMs: 8000 });
    await run('ls -l configs', 'SW2-running-config');
    await run('grep -c ospf configs/*.txt', 'SW2-running-config.txt:');
    await app.run(() => document.querySelector('[title="Terminal + SFTP Side-by-Side Split"]').click());
    await app.waitFor(() => document.body.innerText.includes('images'), [], { timeoutMs: 15000, what: 'the remote listing' });
    await sleep(1000);
    shot(display, path.join(out, 'sftp.png'));
    console.log('sftp.png');
    fs.writeFileSync(path.join(runDir, 'ready'), '');
  } finally {
    if (process.env.KEEP) { console.log('kept at', runDir); } else {
      await app.stop(); sshd.stop(); await Promise.all(Object.values(consoles).map((c) => c.stop())); display.stop();
    }
  }
}

// GNS3's "Console to all nodes": it runs the app once per node with
// --telnet, and the open window takes each one as a tab. Frames are taken
// as fast as `import` manages (about 6 a second) and labelled with what
// GNS3 just did.
async function gns3() {
  const GW = 1480, GH = 820;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thyrion-gif-'));
  const home = '/tmp/home/netops';
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const display = await startDisplay({ runDir, width: GW, height: GH });
  const env = { ...process.env, ...display.env };
  const nodes = ['R1', 'R2', 'SW1', 'SW2'];
  const consoles = Object.fromEntries(await Promise.all(nodes.map(async (n, i) =>
    [n, await startConsole({ name: n, mark: '#', replies: replies(n), port: 5001 + i })])));
  for (const n of nodes) writePuttySession(home, n, { HostName: '127.0.0.1', PortNumber: 5001 + nodes.indexOf(n), Protocol: 'telnet', PlinkyFolder: 'GNS3 lab' });
  const app = await launchApp({ binary, display, home, env: { SHELL: '/bin/bash' }, log: path.join(runDir, 'app.log') });
  // Before recording starts: xdotool waits on the X server while `import`
  // is reading the screen, and the two together hung.
  execFileSync('xdotool', ['search', '--onlyvisible', '--name', 'Thyrion', 'windowmove', '0', '0', 'windowsize', String(GW), String(GH)], { env, stdio: 'ignore' });
  await sleep(800);
  const frames = path.join(out, 'gns3');
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const labels = [];
  let label = '';
  let n = 0;
  let recording = true;
  const recorder = (async () => {
    while (recording) {
      const f = path.join(frames, `${String(n).padStart(4, '0')}.png`);
      // Asynchronous: a synchronous call here never lets the steps run.
      const at = label;
      try { await importAsync(f, env); labels.push(at); n++; } catch { await sleep(50); }
    }
  })();
  const hold = (ms) => sleep(ms);
  try {
    label = 'GNS3 lab is running. Right-click > Console to all nodes...';
    await hold(1500);
    for (const [i, node] of nodes.entries()) {
      label = `GNS3 runs: thyrion --telnet 127.0.0.1 ${5001 + i} --title ${node}`;
      await new Promise((resolve) => {
        const c = spawn(binary, ['--telnet', '127.0.0.1', String(5001 + i), '--title', node], { env: app.env, stdio: 'ignore' });
        c.on('exit', resolve);
        setTimeout(resolve, 8000);
      });
      await app.waitForTab(node, 'live', { timeoutMs: 8000 });
      await hold(700);
    }
    label = 'Four consoles, one window: each node is a tab';
    await hold(1200);
    // Something on each console, typed in turn; then all four at once.
    const cmds = { R1: 'show ip interface brief', R2: 'show ip ospf neighbor', SW1: 'show vlan brief', SW2: 'ping 192.0.2.1' };
    for (const node of nodes) {
      await app.run((e, t) => e.click(e.tabEl(t)), node);
      await app.run((e) => e.focusTerminal());
      await app.key('Enter');
      await typeSlow(app, cmds[node]);
      await hold(500);
    }
    label = 'Split them into a 2x2 grid';
    await app.run((e) => e.click(e.tabEl('R1')));
    await app.run(() => document.querySelector('[title="4-Terminal Cluster Grid (2x2)"]').click());
    await app.run(() => document.activeElement?.blur());
    await hold(1500);
    label = 'Thyrion: every GNS3 console in one window';
    await hold(2500);
  } finally {
    recording = false;
    await recorder;
    fs.writeFileSync(path.join(frames, 'labels.json'), JSON.stringify(labels));
    await app.stop(); await Promise.all(Object.values(consoles).map((c) => c.stop())); display.stop();
  }
  console.log(`${n} frames in ${frames}`);
}

const which = process.argv[3] ?? 'all';
(async () => {
  if (which === 'all' || which === 'stills') await main();
  if (which === 'all' || which === 'gif') await gns3();
})().catch((e) => { console.error(e); process.exit(1); });
