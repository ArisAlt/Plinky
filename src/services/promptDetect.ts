/**
 * Which password, if any, the terminal is waiting for, judged from the
 * tail of its recent output (escape sequences already stripped).
 *
 * Cisco IOS asks for the enable secret with a bare "Password:" right after
 * the user types `enable` at a ">" prompt. Matching only "Enable
 * password:" meant IOS was offered the login password at its enable
 * prompt. Looking at the line before the prompt tells the two apart.
 */
export function classifyPasswordPrompt(recent: string): 'login' | 'enable' | null {
  const tail = recent.replace(/\r/g, '');
  if (!/password:\s*$/i.test(tail)) return null;
  if (/enable\s+password:\s*$/i.test(tail)) return 'enable';
  // "Switch>enable" / "Switch>en" (IOS accepts any prefix of "enable"),
  // echoed on the line just before "Password:".
  if (/>\s*en(?:a|ab|abl|able)?\s*\n+\s*password:\s*$/i.test(tail)) return 'enable';
  return 'login';
}

const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Keeps the last `max` characters of output, without escape sequences. */
export function appendRecentOutput(prev: string, chunk: string, max = 300): string {
  return (prev + chunk.replace(ESCAPES, '')).slice(-max);
}

/** A Username:/login: prompt at the end of the output (Telnet, consoles). */
export function isUsernamePrompt(recent: string): boolean {
  return /(?:user\s?name|login)\s*:\s*$/i.test(recent.replace(/\r/g, ''));
}

/**
 * The line the user is typing, and the last one they submitted. Built from
 * keystrokes, not from the device's echo, so the device can't claim the
 * user typed "enable". Arrow keys and other escape sequences make the line
 * unknowable; it's dropped rather than guessed.
 */
export interface TypedInput {
  line: string | null;
  submitted: { line: string; at: number } | null;
}

export function trackTypedInput(state: TypedInput, data: string, now: number): TypedInput {
  if (data.startsWith('\x1b')) return { ...state, line: null };
  let line = state.line;
  let submitted = state.submitted;
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      if (line !== null) submitted = { line, at: now };
      line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      if (line !== null) line = line.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') {
      line = ''; // Ctrl-C / Ctrl-U
    } else if (ch >= ' ' && line !== null) {
      line = (line + ch).slice(-200);
    }
  }
  return { line, submitted };
}

/**
 * Commands that ask a network device for its privileged-mode password:
 * Cisco/Arista `enable` (any prefix down to `en`, optionally a level such
 * as `enable 15`), Huawei `super`.
 */
export function isPrivilegeCommand(line: string): boolean {
  return /^\s*(?:en|ena|enab|enabl|enable|super)(?:\s+\d+)?\s*$/i.test(line);
}
