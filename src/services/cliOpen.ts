import { OpenRequest } from './tauriBridge';
import { TerminalTab } from '../types/session';

/**
 * Tabs for console requests from the command line (T-020, GNS3's
 * "Custom" console: `plinky --telnet {host} {port} --title "{name}"`).
 */

const hostLabel = (host: string) => (host.includes(':') ? `[${host}]` : host);

export function tabForOpenRequest(r: OpenRequest, id: string): TerminalTab {
  const target = `${hostLabel(r.host)}:${r.port}`;
  return {
    id,
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

/** Runs `fn` once, `ms` after the last of a burst of calls. */
export function debounce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const call = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
  call.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return call;
}
