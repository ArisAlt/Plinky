// Starts the real app with a throwaway profile and drives its page.
//
// The profile is a fresh home directory: saved sessions, host keys, the
// vault and the webview's storage all live under it, so a run never reads or
// changes the user's own. The app also gets its own runtime directory and no
// session bus. Both are needed to keep it apart from a Thyrion the user has
// open: the single-instance plugin looks for a running copy over D-Bus, and
// the GNS3 hand-over socket lives in the runtime directory; either one would
// otherwise pass the test's tabs to the user's window.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { Inspector, CdpInspector } from './inspector.mjs';
import { isWindows, killTree, windowsDiagnosis, DEVTOOLS_PORT } from './windows.mjs';
import { installHelpers } from './page.mjs';
import { freePort, waitUntil } from './fixtures.mjs';

export async function launchApp({ binary, display, home, args = [], env = {}, log: logFile }) {
  // Short: socket paths are limited to 108 bytes. (Windows has no sockets
  // here; the folder is only cleaned up.)
  const runtime = fs.mkdtempSync(isWindows ? path.join(os.tmpdir(), 'pe2e-') : '/tmp/pe2e-');
  const port = isWindows ? DEVTOOLS_PORT : await freePort();
  const log = logFile ?? path.join(home, 'app.log');
  // On Windows the app needs the system's own variables (SystemRoot, the
  // user's folders); its DevTools port is in the test build (windows.mjs)
  // and the profile is reset by run.mjs.
  const appEnv = isWindows ? {
    ...process.env,
    ...display.env,
    ...env,
  } : {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    HOME: home,
    USER: process.env.USER,
    XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/no-bus`,
    WEBKIT_INSPECTOR_HTTP_SERVER: `127.0.0.1:${port}`,
    ...display.env,
    ...env,
  };
  for (const [k, v] of Object.entries(appEnv)) if (v === undefined) delete appEnv[k];

  const out = fs.openSync(log, 'a');
  // Its own process group on Unix, so stop() ends plink with it; Windows
  // ends the tree with taskkill instead.
  const child = spawn(binary, args, { env: appEnv, stdio: ['ignore', out, out], detached: !isWindows });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  let inspector;
  try {
    inspector = await (isWindows ? CdpInspector : Inspector).connect(port, { timeoutMs: 30000 });
  } catch (e) {
    const why = isWindows ? windowsDiagnosis(port, child) : '';
    if (isWindows) killTree(child.pid); else child.kill('SIGKILL');
    throw new Error(`${e.message}${why}\n--- app log ---\n${fs.readFileSync(log, 'utf8').slice(-3000)}`);
  }

  const app = {
    child, home, log, runtime, env: appEnv, inspector,
    get exited() { return exited; },

    /** Runs fn(e2e, ...args) in the page; e2e is the helper object. */
    async run(fn, ...fnArgs) {
      return inspector.evaluate(`(${installHelpers})() && (${fn})(window.__e2e, ...${JSON.stringify(fnArgs)})`);
    },

    /** Polls fn in the page until it returns something truthy. An error in
     *  the page counts as "not yet": while the app starts, the page it first
     *  shows is replaced, and a call can land in the one going away. */
    async waitFor(fn, fnArgs = [], { timeoutMs = 5000, what = 'the page' } = {}) {
      let last;
      try {
        return await waitUntil(async () => {
          try {
            return (last = await app.run(fn, ...fnArgs));
          } catch (e) {
            last = `error: ${e.message}`;
            return false;
          }
        }, { timeoutMs, what });
      } catch (e) {
        throw new Error(`${e.message} (last: ${JSON.stringify(last)})`);
      }
    },

    screen: () => app.run((e) => e.screen()),
    screenText: async () => ((await app.screen()) ?? []).join('\n'),
    tabs: () => app.run((e) => e.tabs()),
    key: (spec) => app.run((e, s) => e.key(s), spec),
    type: (text) => app.run((e, t) => e.type(t), text),
    invoke: (cmd, a) => app.run((e, c, x) => e.invoke(c, x), cmd, a),

    async waitForScreen(pattern, opts = {}) {
      const re = typeof pattern === 'string' ? null : pattern;
      return app.waitFor(
        (e, src, flags, plain) => {
          const text = (e.screen() ?? []).join('\n');
          return plain !== null ? text.includes(plain) : new RegExp(src, flags).test(text);
        },
        [re?.source ?? '', re?.flags ?? '', re ? null : pattern],
        { what: `the terminal to show ${pattern}`, ...opts },
      );
    },

    async waitForTab(title, status, opts = {}) {
      return app.waitFor(
        (e, t, s) => e.tabs().find((x) => x.title === t && (!s || x.status === s)) ?? null,
        [title, status],
        { what: `a tab "${title}"${status ? ` that is ${status}` : ''}`, ...opts },
      );
    },

    async stop() {
      inspector.close();
      if (!exited && isWindows) {
        killTree(child.pid);
        await waitUntil(() => exited, { timeoutMs: 5000 }).catch(() => {});
      } else if (!exited) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
        await waitUntil(() => exited, { timeoutMs: 3000 }).catch(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
        });
      }
      fs.rmSync(runtime, { recursive: true, force: true });
    },
  };

  // The page is up once the session list has rendered. If it never is, stop
  // the app: left running, it kept writing into a profile already deleted.
  try {
    await app.waitFor((e) => !!document.querySelector('[aria-label="Sessions"]'), [], {
      timeoutMs: 20000, what: 'the main window',
    });
  } catch (e) {
    await app.stop();
    throw new Error(`${e.message}\n--- app log ---\n${fs.readFileSync(log, 'utf8').slice(-3000)}`);
  }
  return app;
}
