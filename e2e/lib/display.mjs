// A screen nobody sees, so a test run never opens windows on the desktop.
//
// KDE's own compositor has a virtual backend (kwin_wayland --virtual); a CI
// runner has Xvfb. With neither, the run stops unless --visible is given:
// windows opening and taking focus on the user's desktop mid-run is exactly
// what this module is here to prevent.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { waitUntil } from './fixtures.mjs';

const has = (bin) => {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
};

export async function startDisplay({ runDir, visible = false, width = 1280, height = 860 }) {
  if (visible) {
    return {
      kind: 'your desktop',
      env: {
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DISPLAY: process.env.DISPLAY,
        XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
      },
      stop: () => {},
    };
  }

  if (has('kwin_wayland')) {
    const rt = fs.mkdtempSync(path.join(runDir, 'kwin-'));
    const child = spawn('kwin_wayland', [
      '--virtual', '--socket', 'e2e', '--width', String(width), '--height', String(height), '--no-lockscreen',
    ], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: rt,
        // No session bus: KWin must not register with the user's desktop.
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${rt}/no-bus`,
      },
      stdio: ['ignore', fs.openSync(path.join(runDir, 'kwin.log'), 'a'), fs.openSync(path.join(runDir, 'kwin.log'), 'a')],
    });
    const socket = path.join(rt, 'e2e');
    await waitUntil(() => fs.existsSync(socket), { what: 'the hidden KWin screen', timeoutMs: 10000 });
    return {
      kind: 'hidden KWin screen',
      // An absolute WAYLAND_DISPLAY: the app keeps its own XDG_RUNTIME_DIR.
      env: { WAYLAND_DISPLAY: socket, GDK_BACKEND: 'wayland', XDG_SESSION_TYPE: 'wayland' },
      stop: () => child.kill(),
    };
  }

  if (has('Xvfb')) {
    const displayNo = 90 + Math.floor(Math.random() * 400);
    const child = spawn('Xvfb', [`:${displayNo}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', fs.openSync(path.join(runDir, 'xvfb.log'), 'a')],
    });
    await waitUntil(() => fs.existsSync(`/tmp/.X11-unix/X${displayNo}`), { what: 'Xvfb', timeoutMs: 10000 });
    return {
      kind: 'Xvfb',
      env: { DISPLAY: `:${displayNo}`, GDK_BACKEND: 'x11', XDG_SESSION_TYPE: 'x11' },
      stop: () => child.kill(),
    };
  }

  throw new Error('no hidden screen available: install Xvfb (or run under KDE), or pass --visible to use your desktop');
}
