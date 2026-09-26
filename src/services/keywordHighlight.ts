import type { Terminal, IDisposable, IMarker } from '@xterm/xterm';

/**
 * Keyword highlighting for network-device output (T-017): interface
 * states, syslog severities, IOS error lines, interface names, addresses.
 *
 * Drawn as xterm decorations over the rendered text, not by rewriting the
 * byte stream: the session log, copied text and full-screen programs see
 * exactly what the device sent.
 */

export interface HighlightRule {
  re: RegExp;
  color: string;
}

export interface Highlight {
  start: number;
  end: number;
  color: string;
}

const RED = '#f87171';
const AMBER = '#fbbf24';
const GREEN = '#34d399';
const CYAN = '#22d3ee';
const VIOLET = '#c4b5fd';

/** Earlier rules win where matches overlap. All patterns use the g flag. */
export const NETWORK_RULES: HighlightRule[] = [
  // IOS/NX-OS/EOS command errors: "% Invalid input detected at '^' marker."
  { re: /%\s*(?:Invalid input detected|Incomplete command|Ambiguous command|Unknown command|Bad mask|Error)[^\r\n]*/gi, color: RED },
  // Syslog mnemonics by severity: %FACILITY-SEV-MNEMONIC
  { re: /%[A-Z][A-Z0-9_]*-[0-3]-[A-Z0-9_]+/g, color: RED },
  { re: /%[A-Z][A-Z0-9_]*-4-[A-Z0-9_]+/g, color: AMBER },
  { re: /%[A-Z][A-Z0-9_]*-[5-7]-[A-Z0-9_]+/g, color: CYAN },
  // States
  { re: /\badministratively down\b|\berr-?disabled\b|\bnotconnect\b|\b(?:down|failed|failure|errors?|denied|invalid|unreachable|timed out|timeout|mismatch|blocked|dropped)\b/gi, color: RED },
  { re: /\b(?:warning|warn|flapping|standby|pending|learning|listening|degraded)\b/gi, color: AMBER },
  { re: /\b(?:up|connected|established|forwarding|active|enabled|full)\b/gi, color: GREEN },
  // Interface names (Cisco/Arista/Juniper/Linux styles)
  { re: /\b(?:(?:Ten|Forty|Hundred|TwentyFive)?GigabitEthernet|FastEthernet|Ethernet|Port-channel|Vlan|Loopback|Tunnel|Serial|Management|mgmt|Gi|Te|Fa|Fo|Hu|Eth|Et|Po|Lo|Vl|Tu)\d+(?:\/\d+)*(?:\.\d+)?\b|\b(?:ge|xe|et|ae)-\d+(?:\/\d+)*(?:\.\d+)?\b/g, color: VIOLET },
  // IPv4 (with optional /prefix) and MAC addresses
  { re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\/(?:3[0-2]|[12]?\d))?\b/g, color: CYAN },
  { re: /\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b|\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, color: CYAN },
];

/** Non-overlapping highlights for one line of text, in column order. */
export function findHighlights(text: string, rules: HighlightRule[] = NETWORK_RULES): Highlight[] {
  const taken: Highlight[] = [];
  const overlaps = (s: number, e: number) => taken.some(h => s < h.end && e > h.start);
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (!overlaps(start, end)) taken.push({ start, end, color: rule.color });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** Lines scanned at most per pass, so a huge burst of output can't stall the UI. */
const MAX_LINES_PER_SCAN = 500;
/** Decorations kept before trimming the ones whose lines left the scrollback. */
const PRUNE_AT = 5000;

/**
 * Decorates finished lines as they arrive. The line the cursor is on is
 * left alone until the cursor moves past it (it may still be rewritten --
 * a prompt, a progress counter). Full-screen programs (the alternate
 * buffer: vim, top, less) are never decorated.
 */
export class KeywordHighlighter {
  private items: { marker: IMarker; deco: IDisposable }[] = [];
  private nextLine = 0;
  private enabled: boolean;

  constructor(private term: Terminal, enabled = true) {
    this.enabled = enabled;
  }

  get count(): number {
    return this.items.filter(i => !i.marker.isDisposed).length;
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      // Pick up what's on screen now, not only what arrives next.
      const buf = this.term.buffer.active;
      this.nextLine = Math.max(0, buf.baseY + buf.cursorY - MAX_LINES_PER_SCAN);
      this.scan();
    } else {
      this.clear();
    }
  }

  clear() {
    for (const i of this.items) {
      i.deco.dispose();
      i.marker.dispose();
    }
    this.items = [];
  }

  /** Decorate every finished line not seen yet. Call after output is written. */
  scan() {
    const buf = this.term.buffer.active;
    if (!this.enabled || buf.type !== 'normal') return;
    const cursorLine = buf.baseY + buf.cursorY;
    // Scrollback trimmed or cleared under us: start from what's there.
    if (this.nextLine > cursorLine) this.nextLine = cursorLine;
    const from = Math.max(this.nextLine, cursorLine - MAX_LINES_PER_SCAN);
    for (let y = from; y < cursorLine; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const hits = findHighlights(line.translateToString(true));
      if (hits.length === 0) continue;
      for (const h of hits) {
        const marker = this.term.registerMarker(y - cursorLine);
        if (!marker) continue;
        const deco = this.term.registerDecoration({
          marker,
          x: h.start,
          width: h.end - h.start,
          foregroundColor: h.color,
          layer: 'top',
        });
        if (deco) this.items.push({ marker, deco });
        else marker.dispose();
      }
    }
    this.nextLine = cursorLine;
    if (this.items.length > PRUNE_AT) this.items = this.items.filter(i => !i.marker.isDisposed);
  }

  dispose() {
    this.clear();
  }
}
