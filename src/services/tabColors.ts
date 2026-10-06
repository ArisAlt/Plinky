// A saved session's tab colour (Session settings > General), shown on its
// tabs and in the session list: production in red, a lab in green, so a
// command goes to the box it was meant for. Stored as PlinkyTabColor.
export const TAB_COLORS = [
  { id: 'red', label: 'Red', hex: '#ef4444' },
  { id: 'orange', label: 'Orange', hex: '#f97316' },
  { id: 'yellow', label: 'Yellow', hex: '#eab308' },
  { id: 'green', label: 'Green', hex: '#22c55e' },
  { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  { id: 'purple', label: 'Purple', hex: '#a855f7' },
] as const;

/** The colour for a PlinkyTabColor value; undefined for none or unknown. */
export function tabColorHex(id: string | undefined): string | undefined {
  return TAB_COLORS.find(c => c.id === id)?.hex;
}

/** PlinkyLogonActions: a JSON list of [wait for, send] pairs. */
export type LogonAction = { wait: string; send: string };

export function parseLogonActions(raw: string | undefined): LogonAction[] {
  if (!raw) return [];
  try {
    const pairs = JSON.parse(raw);
    return Array.isArray(pairs)
      ? pairs.filter(p => Array.isArray(p) && p.length === 2).map(([wait, send]) => ({ wait: String(wait), send: String(send) }))
      : [];
  } catch {
    return [];
  }
}

export function serializeLogonActions(actions: LogonAction[]): string | undefined {
  const pairs = actions.filter(a => a.send.trim()).map(a => [a.wait.trim(), a.send]);
  return pairs.length ? JSON.stringify(pairs) : undefined;
}
