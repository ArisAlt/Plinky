/**
 * Sessions opened most recently, newest first, for the tab launcher.
 * Browser storage can be unavailable or cleared; every access is guarded and
 * the launcher works without it (it just has no "Recent" section).
 */

const KEY = 'plinky_recent_sessions';
export const MAX_RECENT = 8;

export function getRecentSessions(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export function recordRecentSession(name: string): void {
  if (!name) return;
  try {
    const next = [name, ...getRecentSessions().filter(n => n !== name)].slice(0, MAX_RECENT);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: recents are a convenience, not state.
  }
}
