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
