/**
 * Nested session folders.
 *
 * A folder is a path of segments joined by '/', stored as the session's
 * PlinkyFolder value: "Corp 1/Site 1/Site 1 Production". PuTTY's own store
 * stays flat -- it never reads PlinkyFolder -- so nesting is Plinky-only.
 *
 * '/' is refused inside a folder name rather than escaped. An escape would
 * have to survive every tool that reads or hand-edits a PuTTY session file,
 * and a name that is silently split into two levels is exactly what this has
 * to prevent. A name saved before nesting existed that already contains '/'
 * therefore now reads as nested -- which is what such a name was usually
 * reaching for.
 */

import type { PuttySession } from '../types/session';

export const FOLDER_SEPARATOR = '/';
/** Where a session with no folder is shown, and where it was always shown. */
export const DEFAULT_FOLDER = 'Saved Sessions';

/** Splits a stored path into its segments, trimming and dropping empties. */
export function parseFolderPath(path: string | undefined | null): string[] {
  if (!path) return [];
  return path
    .split(FOLDER_SEPARATOR)
    .map(s => s.trim())
    .filter(Boolean);
}

export function joinFolderPath(segments: string[]): string {
  return segments.join(FOLDER_SEPARATOR);
}

/** " Corp 1 / /Site 1/" -> "Corp 1/Site 1". Empty for an empty path. */
export function normalizeFolderPath(path: string | undefined | null): string {
  return joinFolderPath(parseFolderPath(path));
}

/** The folder a session is shown under. */
export function sessionFolder(session: Pick<PuttySession, 'folder'>): string {
  return normalizeFolderPath(session.folder) || DEFAULT_FOLDER;
}

/** Why `name` can't be one folder's name, or null when it can. */
export function folderNameError(name: string): string | null {
  const clean = name.trim();
  if (!clean) return 'Folder name cannot be empty.';
  if (clean.includes(FOLDER_SEPARATOR)) {
    return `Folder names cannot contain "${FOLDER_SEPARATOR}" -- it separates levels. Use "New Subfolder" to nest.`;
  }
  return null;
}

export function parentPath(path: string): string {
  return joinFolderPath(parseFolderPath(path).slice(0, -1));
}

export function lastSegment(path: string): string {
  const segs = parseFolderPath(path);
  return segs[segs.length - 1] || '';
}

export function childPath(parent: string, name: string): string {
  return joinFolderPath([...parseFolderPath(parent), name.trim()]);
}

/** True when `path` is `ancestor` or sits anywhere below it. */
export function isSameOrDescendant(path: string, ancestor: string): boolean {
  const p = parseFolderPath(path);
  const a = parseFolderPath(ancestor);
  if (a.length === 0 || a.length > p.length) return false;
  return a.every((seg, i) => seg === p[i]);
}

/**
 * `path` with its `oldPrefix` swapped for `newPrefix`, or null when `path` is
 * not under `oldPrefix`. Segment-wise: renaming "Site 1" must not touch
 * "Site 10".
 */
export function rebasePath(path: string, oldPrefix: string, newPrefix: string): string | null {
  if (!isSameOrDescendant(path, oldPrefix)) return null;
  const rest = parseFolderPath(path).slice(parseFolderPath(oldPrefix).length);
  return joinFolderPath([...parseFolderPath(newPrefix), ...rest]);
}

/** Every ancestor of `path`, then `path` itself: "a/b/c" -> a, a/b, a/b/c. */
export function withAncestors(path: string): string[] {
  const segs = parseFolderPath(path);
  return segs.map((_, i) => joinFolderPath(segs.slice(0, i + 1)));
}

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  sessions: PuttySession[];
}

/**
 * The folder tree for `folderPaths` (folders that exist even when empty)
 * plus every folder a session names. Ancestors are implied: a session in
 * "a/b/c" makes "a" and "a/b" appear even if nothing else lives there.
 * Folders and sessions are sorted by name at every level.
 */
export function buildFolderTree(folderPaths: string[], sessions: PuttySession[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];

  const ensure = (path: string): FolderNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: FolderNode = { name: lastSegment(path), path, children: [], sessions: [] };
    nodes.set(path, node);
    const parent = parentPath(path);
    if (parent) ensure(parent).children.push(node);
    else roots.push(node);
    return node;
  };

  for (const p of folderPaths) {
    const clean = normalizeFolderPath(p);
    if (clean) ensure(clean);
  }
  for (const s of sessions) ensure(sessionFolder(s)).sessions.push(s);

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const sortDeep = (list: FolderNode[]) => {
    list.sort(byName);
    for (const n of list) {
      n.sessions.sort(byName);
      sortDeep(n.children);
    }
  };
  sortDeep(roots);
  return roots;
}

/** Every session in `node` and all of its subfolders. */
export function collectSessions(node: FolderNode): PuttySession[] {
  return [...node.sessions, ...node.children.flatMap(collectSessions)];
}

/** Every folder path in the tree, depth first. */
export function collectFolderPaths(nodes: FolderNode[]): string[] {
  return nodes.flatMap(n => [n.path, ...collectFolderPaths(n.children)]);
}

/**
 * Keeps only the nodes that match `query` (folder name or session), with
 * their ancestors. A matching folder keeps everything under it.
 */
export function filterFolderTree(
  nodes: FolderNode[],
  query: string,
  sessionMatches: (s: PuttySession) => boolean,
): FolderNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: FolderNode[] = [];
  for (const n of nodes) {
    if (n.name.toLowerCase().includes(q)) {
      out.push(n);
      continue;
    }
    const children = filterFolderTree(n.children, query, sessionMatches);
    const sessions = n.sessions.filter(sessionMatches);
    if (children.length || sessions.length) out.push({ ...n, children, sessions });
  }
  return out;
}

export interface FolderMovePlan {
  /** [session name, new folder path] for every session under the folder. */
  sessionChanges: [string, string][];
  /** The user-folder list afterwards. */
  userFolders: string[];
}

/**
 * Everything that changes when folder `from` becomes `to` -- a rename
 * (same parent) or a move (new parent). Throws when `to` is `from` itself or
 * one of its own subfolders: that would detach the folder from the tree.
 */
export function planFolderMove(
  from: string,
  to: string,
  sessions: PuttySession[],
  userFolders: string[],
): FolderMovePlan {
  const src = normalizeFolderPath(from);
  const dst = normalizeFolderPath(to);
  if (!src || !dst) throw new Error('Folder path cannot be empty.');
  if (src === DEFAULT_FOLDER) throw new Error(`"${DEFAULT_FOLDER}" cannot be renamed or moved.`);
  if (isSameOrDescendant(dst, src)) {
    throw new Error(dst === src
      ? 'The folder is already there.'
      : 'A folder cannot be moved into itself or one of its own subfolders.');
  }

  const sessionChanges: [string, string][] = [];
  for (const s of sessions) {
    const moved = rebasePath(sessionFolder(s), src, dst);
    if (moved !== null) sessionChanges.push([s.name, moved]);
  }

  const next = new Set<string>();
  for (const f of userFolders) {
    const clean = normalizeFolderPath(f);
    if (!clean) continue;
    next.add(rebasePath(clean, src, dst) ?? clean);
  }
  // The destination keeps existing even if it held no sessions.
  next.add(dst);

  return { sessionChanges, userFolders: Array.from(next).sort() };
}

/**
 * The collapsed-folder map after `from` is renamed to `to` (or deleted, when
 * `to` is null). Keys under `from` move with it; without this, a stale key
 * would collapse whichever folder later took the old name.
 */
export function rebaseCollapsed(
  collapsed: Record<string, boolean>,
  from: string,
  to: string | null,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(collapsed)) {
    if (!value) continue;
    if (!isSameOrDescendant(path, from)) {
      out[path] = value;
    } else if (to !== null) {
      const moved = rebasePath(path, from, to);
      if (moved) out[moved] = value;
    }
  }
  return out;
}

/** Drops collapsed keys for folders that no longer exist. */
export function pruneCollapsed(
  collapsed: Record<string, boolean>,
  existing: Iterable<string>,
): Record<string, boolean> {
  const live = new Set(existing);
  const out: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(collapsed)) {
    if (value && live.has(path)) out[path] = value;
  }
  return out;
}
