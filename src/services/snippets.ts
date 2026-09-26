import { SnippetItem } from '../types/session';

/**
 * Quick snippets (T-013): kept across restarts, with ${PARAM} placeholders
 * asked for each time a snippet runs.
 *
 *   ${NAME}          asked every run
 *   ${NAME:default}  asked, pre-filled with the default
 *   $${NAME}         not a parameter: sends a literal ${NAME}, for shell
 *                    variables such as $${HOME} ("$$" alone is untouched)
 *
 * Only the snippets are stored. The values typed for their parameters are
 * not, so a password can be a parameter.
 */

const KEY = 'plinky_snippets';

const CATEGORIES: SnippetItem['category'][] = ['System', 'Docker', 'Logs', 'Network', 'Custom'];

export const DEFAULT_SNIPPETS: SnippetItem[] = [
  { id: '1', name: 'Docker PS', command: 'docker ps --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"\n', category: 'Docker' },
  { id: '2', name: 'Docker Stats', command: 'docker stats --no-stream\n', category: 'Docker' },
  { id: '3', name: 'Disk Usage', command: 'df -h\n', category: 'System' },
  { id: '4', name: 'Memory', command: 'free -h\n', category: 'System' },
  { id: '5', name: 'System Load', command: 'uptime\n', category: 'System' },
  { id: '6', name: 'Open Ports', command: 'ss -tulpn\n', category: 'Network' },
  { id: '7', name: 'Recent Logs', command: 'journalctl -xe --no-pager -n 50\n', category: 'Logs' },
  { id: '8', name: 'Tail Syslog', command: 'tail -f /var/log/syslog\n', category: 'Logs' },
  { id: '9', name: 'Git Status', command: 'git status -sb\n', category: 'Custom' },
  { id: '10', name: 'Show Interface', command: 'show interfaces ${INTERFACE:GigabitEthernet0/1}\n', category: 'Network' },
  { id: '11', name: 'Ping Host', command: 'ping ${HOST}\n', category: 'Network' },
];

/** The saved snippets, or the defaults on first run or when storage is unreadable. */
export function loadSnippets(): SnippetItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_SNIPPETS;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return DEFAULT_SNIPPETS;
    return list.filter((s): s is SnippetItem =>
      !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.command === 'string'
      && CATEGORIES.includes(s.category));
  } catch {
    return DEFAULT_SNIPPETS;
  }
}

export function saveSnippets(snippets: SnippetItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(snippets));
  } catch {
    // Storage unavailable: the change lasts until the app closes.
  }
}

export interface SnippetParam {
  name: string;
  defaultValue: string;
}

// "$${" first, so an escaped placeholder is never read as one. A "$$" not
// followed by "{" is left alone: it's the shell's own PID variable.
const TOKEN = /\$\$(?=\{)|\$\{([A-Za-z_][A-Za-z0-9_-]*)(?::([^}]*))?\}/g;

/** The parameters a command asks for, each once, in order of first use. */
export function snippetParams(command: string): SnippetParam[] {
  const seen = new Map<string, SnippetParam>();
  for (const m of command.matchAll(TOKEN)) {
    const name = m[1];
    if (!name) continue; // "$${"
    const existing = seen.get(name);
    if (!existing) seen.set(name, { name, defaultValue: m[2] ?? '' });
    else if (!existing.defaultValue && m[2]) existing.defaultValue = m[2];
  }
  return [...seen.values()];
}

/** The command with every placeholder replaced; "$${" becomes "${". */
export function fillSnippet(command: string, values: Record<string, string>): string {
  return command.replace(TOKEN, (_whole, name: string | undefined, dflt: string | undefined) => {
    if (!name) return '$';
    return values[name] ?? dflt ?? '';
  });
}
