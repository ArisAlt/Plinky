import { OpenRequest } from './tauriBridge';
import { TerminalTab } from '../types/session';

/**
 * Tabs for console requests from the command line (T-020, GNS3's
 * "Custom" console: `plinky --telnet {host} {port} --title "{name}"`).
 */

const hostLabel = (host: string) => (host.includes(':') ? `[${host}]` : host);

/** `fallbackId` is used only when the backend didn't start the session
 *  (no `sessionId`); otherwise the tab takes the session's id, to attach. */
export function tabForOpenRequest(r: OpenRequest, fallbackId: string): TerminalTab {
  const target = `${hostLabel(r.host)}:${r.port}`;
  return {
    id: r.sessionId || fallbackId,
    title: r.title || target,
    // Not the title: a saved PuTTY session with the same name ("R1") would
    // be -loaded instead of this console.
    sessionName: `${r.protocol}://${target}`,
    syncChannel: 'none',
    status: 'connecting',
    freeTypeMode: false,
    activeHighlighting: true,
    hostname: r.host,
    port: r.port,
    username: r.user || undefined,
    protocol: r.protocol === 'telnet' ? 'Telnet' : r.protocol === 'raw' ? 'RAW' : 'SSH',
  };
}

/** Runs `fn` at once, then at most once per `ms` while calls keep coming:
 *  the first console of a burst opens immediately, the rest in batches.
 *  (It was a 60 ms debounce: every console waited 60 ms before its tab.) */
export function throttle(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  const call = () => {
    if (timer) { pending = true; return; }
    fn();
    timer = setTimeout(() => {
      timer = null;
      if (pending) { pending = false; call(); }
    }, ms);
  };
  call.cancel = () => { if (timer) clearTimeout(timer); timer = null; pending = false; };
  return call;
}
