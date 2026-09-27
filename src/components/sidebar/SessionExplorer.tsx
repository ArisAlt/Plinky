import React, { useState } from 'react';
import { PuttySession, TerminalTab } from '../../types/session';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  FolderInput,
  FolderPlus,
  Terminal,
  Search,
  Plus,
  HardDrive,
  Tag,
  Pencil,
  Trash2,
  X,
  Lock,
  Play,
} from 'lucide-react';
import {
  getUserFolders,
  addUserFolder,
  deleteUserFolder,
  setUserFolders,
  getCollapsedFolders,
  saveCollapsedFolders,
} from '../../services/sessionMetadata';
import {
  DEFAULT_FOLDER,
  FolderNode,
  buildFolderTree,
  childPath,
  collectFolderPaths,
  collectSessions,
  filterFolderTree,
  folderNameError,
  isSameOrDescendant,
  lastSegment,
  parentPath,
  planFolderMove,
  pruneCollapsed,
  rebaseCollapsed,
  sessionFolder,
} from '../../services/folderTree';
import { setSessionFolders } from '../../services/tauriBridge';

interface SessionExplorerProps {
  sessions: PuttySession[];
  tabs: TerminalTab[];
  activeTabId: string | null;
  onConnectSession: (session: PuttySession, forceNew?: boolean) => void;
  onOpenSftp: (session: PuttySession) => void;
  /** Opens the session editor; with a folder, pre-filled with it. */
  onCreateSession: (folder?: string) => void;
  onEditSession: (session: PuttySession) => void;
  onMoveToFolder: (session: PuttySession, folder: string) => void;
  /** Reload sessions after a folder rename or move rewrote them. */
  onFoldersChanged?: () => void | Promise<void>;
}

type Dragging =
  | { kind: 'session'; session: PuttySession }
  | { kind: 'folder'; path: string };

/** An inline name editor: a new top-level folder, a subfolder, or a rename. */
type FolderEdit =
  | { mode: 'new-sub'; path: string; value: string }
  | { mode: 'rename'; path: string; value: string };

/** "Corp 1/Site 1" shown as "Corp 1 / Site 1". */
const displayPath = (path: string) => path.split('/').join(' / ');

export const SessionExplorer: React.FC<SessionExplorerProps> = ({
  sessions,
  tabs,
  activeTabId,
  onConnectSession,
  onOpenSftp,
  onCreateSession,
  onEditSession,
  onMoveToFolder,
  onFoldersChanged,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>(getCollapsedFolders);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; session: PuttySession } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; node: FolderNode } | null>(null);
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);
  const [newFolderInput, setNewFolderInput] = useState('');
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [createFolderName, setCreateFolderName] = useState('');
  const [folderEdit, setFolderEdit] = useState<FolderEdit | null>(null);
  const [confirmConnect, setConfirmConnect] = useState<{ path: string; sessions: PuttySession[] } | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderVersion, setFolderVersion] = useState(0);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const treeRef = React.useRef<HTMLDivElement>(null);

  // Ctrl+Shift+O: jump to the session search from anywhere, even a focused
  // terminal. Bare Ctrl+letters belong to the shell (Ctrl+K kills the line);
  // Ctrl+Shift is where terminal emulators keep their own shortcuts.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    // The empty workspace's "Open a session" button asks for the same.
    const focusSearch = () => { searchRef.current?.focus(); searchRef.current?.select(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('plinky:focus-session-search', focusSearch);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('plinky:focus-session-search', focusSearch);
    };
  }, []);

  /** Tree rows and folder headers in the order they are drawn. */
  const treeItems = (): HTMLElement[] =>
    Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[data-tree-item]') ?? []);

  const focusItem = (el: HTMLElement | undefined) => {
    if (!el) return;
    el.focus();
    el.scrollIntoView?.({ block: 'nearest' });
  };

  // Keyboard tree: Up/Down move, Right opens a folder (or steps into it),
  // Left closes it (or steps out to its parent), Enter connects a session,
  // F2 edits a session or renames a folder, Home/End jump. The tree was
  // mouse-only: double-click was the only way to connect.
  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = treeItems();
    const current = (e.target as HTMLElement).closest<HTMLElement>('[data-tree-item]');
    if (!current || (e.target as HTMLElement).tagName === 'INPUT') return;
    const i = items.indexOf(current);
    const folderPath = current.dataset.folderPath;
    const sessionName = current.dataset.sessionRow;
    const session = sessionName !== undefined ? sessions.find(x => x.name === sessionName) : undefined;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusItem(items[i + 1]); break;
      case 'ArrowUp': e.preventDefault(); focusItem(items[i - 1]); break;
      case 'Home': e.preventDefault(); focusItem(items[0]); break;
      case 'End': e.preventDefault(); focusItem(items[items.length - 1]); break;
      case 'ArrowRight':
        if (folderPath !== undefined) {
          e.preventDefault();
          // While searching, folders are always shown open: just move.
          if (!searching && collapsedFolders[folderPath]) toggleFolder(folderPath);
          else focusItem(items[i + 1]);
        }
        break;
      case 'ArrowLeft': {
        e.preventDefault();
        if (folderPath !== undefined && !searching && !collapsedFolders[folderPath]) {
          toggleFolder(folderPath);
          break;
        }
        const parent = folderPath !== undefined
          ? parentPath(folderPath)
          : session ? sessionFolder(session) : '';
        if (parent) focusItem(items.find(el => el.dataset.folderPath === parent));
        break;
      }
      case 'Enter':
        if (session) { e.preventDefault(); onConnectSession(session, true); }
        break;
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) break;
        e.preventDefault();
        const r = current.getBoundingClientRect();
        const at = { x: r.left + 24, y: r.bottom };
        if (session) { setFolderMenu(null); setContextMenu({ ...at, session }); }
        else if (folderPath !== undefined) {
          const node = findFolderNode(folderPath);
          if (node) { setContextMenu(null); setFolderMenu({ ...at, node }); }
        }
        break;
      }
      case 'F2':
        e.preventDefault();
        if (session) onEditSession(session);
        else if (folderPath !== undefined && folderPath !== DEFAULT_FOLDER) {
          setFolderEdit({ mode: 'rename', path: folderPath, value: lastSegment(folderPath) });
        }
        break;
    }
  };

  React.useEffect(() => {
    const handleOutsideClick = () => {
      setContextMenu(null);
      setFolderMenu(null);
      setMoveSubmenuOpen(false);
      setNewFolderInput('');
    };
    // Escape closes an open menu. It didn't: a folder menu stayed up and a
    // right-click on a session opened a second menu on top of it.
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleOutsideClick();
    };
    window.addEventListener('click', handleOutsideClick);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('click', handleOutsideClick);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const updateCollapsed = (next: Record<string, boolean>) => {
    setCollapsedFolders(next);
    saveCollapsedFolders(next);
  };

  const toggleFolder = (path: string) => {
    const next = { ...collapsedFolders };
    if (next[path]) delete next[path];
    else next[path] = true;
    updateCollapsed(next);
  };

  // User-created folders (kept even when empty) plus every folder a session
  // names, nested by path.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tree = React.useMemo(() => buildFolderTree(getUserFolders(), sessions), [sessions, folderVersion]);

  /** The folder node at `path`, for opening its menu from the keyboard. */
  const findFolderNode = (path: string): FolderNode | undefined => {
    const walk = (nodes: FolderNode[]): FolderNode | undefined => {
      for (const n of nodes) {
        if (n.path === path) return n;
        const hit = walk(n.children);
        if (hit) return hit;
      }
      return undefined;
    };
    return walk(tree);
  };
  const allFolderPaths = React.useMemo(() => collectFolderPaths(tree), [tree]);

  // A collapsed key whose folder is gone would collapse whichever folder
  // later takes that path.
  React.useEffect(() => {
    const pruned = pruneCollapsed(collapsedFolders, allFolderPaths);
    if (Object.keys(pruned).length !== Object.keys(collapsedFolders).length) updateCollapsed(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFolderPaths]);

  const sessionMatches = (s: PuttySession) => {
    const q = searchQuery.toLowerCase();
    const name = (s.name || '').toLowerCase();
    const host = (s.hostname || s.host_name || '').toLowerCase();
    const folder = (s.folder || '').toLowerCase();
    return (
      name.includes(q) ||
      host.includes(q) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(q))) ||
      folder.includes(q)
    );
  };

  const searching = searchQuery.trim().length > 0;
  const visibleTree = filterFolderTree(tree, searchQuery, sessionMatches);
  const filteredSessions = sessions.filter(sessionMatches);

  /** Rename or move folder `from` to path `to`, rewriting every session under it. */
  const moveFolder = async (from: string, to: string) => {
    setFolderError(null);
    if (allFolderPaths.includes(to)) {
      setFolderError(`A folder "${displayPath(to)}" already exists.`);
      return false;
    }
    let plan;
    try {
      plan = planFolderMove(from, to, sessions, getUserFolders());
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e));
      return false;
    }
    setFolderBusy(true);
    try {
      // PuTTY's store first: the sidecar and the collapsed state only
      // follow once every session file has changed.
      await setSessionFolders(plan.sessionChanges);
      setUserFolders(plan.userFolders);
      updateCollapsed(rebaseCollapsed(collapsedFolders, from, to));
      setFolderVersion(v => v + 1);
      await onFoldersChanged?.();
      return true;
    } catch (e) {
      setFolderError(`Nothing was moved: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setFolderBusy(false);
    }
  };

  const deleteFolder = (node: FolderNode) => {
    deleteUserFolder(node.path);
    updateCollapsed(rebaseCollapsed(collapsedFolders, node.path, null));
    setFolderVersion(v => v + 1);
  };

  const createFolder = (path: string) => {
    addUserFolder(path);
    // A new subfolder should be visible straight away.
    const parent = parentPath(path);
    if (parent && collapsedFolders[parent]) toggleFolder(parent);
    setFolderVersion(v => v + 1);
  };

  const editError = (edit: FolderEdit): string | null => {
    const nameError = folderNameError(edit.value);
    if (nameError) return nameError;
    const target = edit.mode === 'rename'
      ? childPath(parentPath(edit.path), edit.value)
      : childPath(edit.path, edit.value);
    if (edit.mode === 'rename' && target === edit.path) return null;
    if (allFolderPaths.includes(target)) return `"${displayPath(target)}" already exists.`;
    return null;
  };

  const commitEdit = async () => {
    if (!folderEdit || editError(folderEdit)) return;
    if (folderEdit.mode === 'new-sub') {
      createFolder(childPath(folderEdit.path, folderEdit.value));
      setFolderEdit(null);
      return;
    }
    const to = childPath(parentPath(folderEdit.path), folderEdit.value);
    if (to === folderEdit.path || (await moveFolder(folderEdit.path, to))) setFolderEdit(null);
  };

  /** Where dragging folder `path` onto `target` would put it, or null when it can't go there. */
  const folderDropTarget = (path: string, target: string): string | null => {
    // Into itself or its own subfolder would detach it from the tree; onto
    // its current parent changes nothing.
    if (isSameOrDescendant(target, path) || parentPath(path) === target) return null;
    const dest = target ? childPath(target, lastSegment(path)) : lastSegment(path);
    return allFolderPaths.includes(dest) ? null : dest;
  };

  const canDropOn = (target: string) => {
    if (!dragging) return false;
    if (dragging.kind === 'session') return sessionFolder(dragging.session) !== target;
    return folderDropTarget(dragging.path, target) !== null;
  };

  const dropOn = (target: string) => {
    const d = dragging;
    setDragOverFolder(null);
    setDragging(null);
    if (!d) return;
    if (d.kind === 'session') {
      onMoveToFolder(d.session, target);
      return;
    }
    const dest = folderDropTarget(d.path, target);
    if (dest) void moveFolder(d.path, dest);
  };

  const dropHandlers = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canDropOn(target)) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOverFolder(target);
    },
    onDragLeave: () => setDragOverFolder(prev => (prev === target ? null : prev)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dropOn(target);
    },
  });

  const getProtocolBadge = (protocol: string) => {
    switch (protocol) {
      case 'SSH':
        return <span className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-sky-500/20 text-sky-400">SSH</span>;
      case 'Serial':
        return <span className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-purple-500/20 text-purple-400">COM</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-slate-700 text-slate-300">{protocol}</span>;
    }
  };

  /** Default port per protocol: a row shows the port only when it differs. */
  const DEFAULT_PORTS: Record<string, number> = { SSH: 22, Telnet: 23, Rlogin: 513 };

  /** The row's second line: where the session goes, in the fewest characters. */
  const sessionTarget = (session: PuttySession): string => {
    if (session.protocol === 'Serial') {
      const line = session.extra?.SerialLine || session.hostname;
      const speed = session.extra?.SerialSpeed;
      return line ? (speed ? `${line} @ ${speed}` : line) : 'No serial line set';
    }
    if (!session.hostname) return session.name === 'Local Shell' ? 'Local shell' : 'No host set';
    const def = DEFAULT_PORTS[session.protocol];
    return session.port && session.port !== def ? `${session.hostname}:${session.port}` : session.hostname;
  };

  // One dense row (owner decision after the impeccable critique). The two
  // densities cost either the names ("we...", "ac..." in compact view, so
  // web-prod-1 and web-prod-2 looked the same) or the list (comfortable
  // cards fit 6 of 12 sessions in a 900 px window). The name now gets the
  // width: the host sits under it in a quieter tone, a protocol chip shows
  // only when it isn't SSH, and the actions float over the row's end on
  // hover or keyboard focus instead of reserving space.
  const renderSession = (session: PuttySession) => {
    const openTab = tabs.find(t => t.sessionName === session.name);
    const isActiveTab = !!openTab && openTab.id === activeTabId;
    const target = sessionTarget(session);
    const tags = session.tags && session.tags.length > 0 ? session.tags.join(', ') : '';
    return (
      <div
        key={session.name}
        data-session-row={session.name}
        data-tree-item
        role="treeitem"
        tabIndex={-1}
        aria-label={`${session.name}, ${target}${openTab ? ', open' : ''}`}
        draggable
        onDragStart={(e) => {
          setDragging({ kind: 'session', session });
          e.dataTransfer.setData('text/plain', session.name);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => {
          setDragging(null);
          setDragOverFolder(null);
        }}
        onDoubleClick={() => onConnectSession(session, true)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFolderMenu(null);
          setContextMenu({ x: e.clientX, y: e.clientY, session });
        }}
        className={`group relative flex items-center gap-2 pl-1.5 pr-1.5 py-1 rounded cursor-pointer select-none transition-colors outline-none focus-visible:ring-1 focus-visible:ring-sky-500/70 ${
          isActiveTab
            ? 'bg-sky-500/15'
            : 'hover:bg-plinky-800/70'
        }`}
      >
        {/* Status slot: fixed width so names line up whether or not a tab is open. */}
        <span className="w-1.5 shrink-0 flex justify-center" aria-hidden={!openTab}>
          {openTab && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${isActiveTab ? 'bg-emerald-400' : 'bg-emerald-500/50'}`}
              title={isActiveTab ? 'Open in the active tab' : 'Open in another tab'}
            />
          )}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 min-w-0">
            <span className={`text-[13px] font-medium truncate ${isActiveTab ? 'text-sky-100' : 'text-slate-100'}`}>
              {session.name}
            </span>
            {session.extra?.PlinkyVaultKey && (
              <Lock
                className="w-2.5 h-2.5 text-amber-400/90 shrink-0"
                aria-label="Password saved in the vault"
              />
            )}
          </div>
          <div className="font-mono text-[11px] leading-tight text-plinky-muted truncate">
            {target}
            {tags && <span className="font-sans text-plinky-muted"> · {tags}</span>}
          </div>
        </div>

        {session.protocol !== 'SSH' && getProtocolBadge(session.protocol)}

        {/* Actions: over the row's end, visible on hover or keyboard focus. */}
        <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex items-center gap-0.5 pl-3 bg-gradient-to-l from-plinky-800 via-plinky-800 to-transparent rounded-r">
          {session.protocol === 'SSH' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSftp(session);
              }}
              aria-label={`Open SFTP for ${session.name}`}
              className="p-1 rounded text-emerald-400 hover:bg-emerald-500/20"
            >
              <HardDrive className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEditSession(session);
            }}
            aria-label={`Edit ${session.name}`}
            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-plinky-700"
          >
            <Pencil className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  };

  const renderFolderEditor = (edit: FolderEdit) => {
    const error = editError(edit);
    return (
      <div className="space-y-0.5" onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          autoFocus
          aria-label={edit.mode === 'rename' ? 'Rename folder' : 'New subfolder name'}
          placeholder={edit.mode === 'rename' ? 'New name, Enter to rename' : 'Subfolder name, Enter to create'}
          value={edit.value}
          disabled={folderBusy}
          onChange={(e) => setFolderEdit({ ...edit, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitEdit();
            else if (e.key === 'Escape') setFolderEdit(null);
          }}
          onBlur={() => { if (!folderBusy) setFolderEdit(null); }}
          className={`w-full bg-plinky-900 border rounded px-1.5 py-0.5 text-[11px] text-slate-200 placeholder-plinky-muted focus:outline-none ${
            error && edit.value ? 'border-rose-500/70' : 'border-plinky-700 focus:border-sky-500'
          }`}
        />
        {error && edit.value && <div role="alert" className="text-[11px] text-rose-400 px-0.5">{error}</div>}
      </div>
    );
  };

  const renderFolder = (node: FolderNode): React.ReactNode => {
    // Search results are always shown expanded.
    const isCollapsed = !searching && !!collapsedFolders[node.path];
    const total = collectSessions(node).length;
    const isDefault = node.path === DEFAULT_FOLDER;
    const isEmpty = node.sessions.length === 0 && node.children.length === 0;
    const renaming = folderEdit?.mode === 'rename' && folderEdit.path === node.path;
    const addingSub = folderEdit?.mode === 'new-sub' && folderEdit.path === node.path;
    return (
      <div key={node.path} className="space-y-1">
        {renaming ? (
          renderFolderEditor(folderEdit)
        ) : (
          <button
            onClick={() => toggleFolder(node.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(null);
              setFolderMenu({ x: e.clientX, y: e.clientY, node });
            }}
            draggable={!isDefault}
            onDragStart={(e) => {
              e.stopPropagation();
              setDragging({ kind: 'folder', path: node.path });
              e.dataTransfer.setData('text/plain', node.path);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              setDragging(null);
              setDragOverFolder(null);
            }}
            {...dropHandlers(node.path)}
            aria-expanded={!isCollapsed}
            data-folder-path={node.path}
            data-tree-item
            role="treeitem"
            tabIndex={-1}
            className={`w-full flex items-center space-x-1.5 px-1 py-1 rounded text-[13px] font-medium transition-colors text-left outline-none focus-visible:ring-1 focus-visible:ring-sky-500/70 ${
              dragOverFolder === node.path
                ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/50'
                : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/50'
            }`}
          >
            {/* The chevron turns; the folder only opens or closes. Rotating
                the folder itself made a collapsed one read as a file. */}
            <ChevronRight
              aria-hidden="true"
              className={`w-3 h-3 shrink-0 text-plinky-muted transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`}
            />
            {isCollapsed
              ? <Folder aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-plinky-muted" />
              : <FolderOpen aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-sky-400" />}
            <span className="flex-1 truncate">{node.name}</span>
            <span className="text-[11px] text-plinky-muted tabular-nums">({total})</span>
            {total === 0 && !isDefault && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  deleteFolder(node);
                }}
                title="Delete empty folder"
                className="p-0.5 rounded text-plinky-muted hover:text-rose-400 hover:bg-rose-500/10 transition"
              >
                <Trash2 className="w-3 h-3" />
              </span>
            )}
          </button>
        )}

        {!isCollapsed && (
          <div className={`ml-3 pl-2 border-l border-plinky-800/80 space-y-px`}>
            {addingSub && renderFolderEditor(folderEdit)}
            {node.children.map(renderFolder)}
            {isEmpty && !addingSub ? (
              <div
                {...dropHandlers(node.path)}
                className={`py-2 px-2 my-1 text-center rounded border border-dashed transition text-[11px] ${
                  dragOverFolder === node.path
                    ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                    : 'border-plinky-800/80 text-plinky-muted hover:border-slate-700'
                }`}
              >
                Empty folder. Drag sessions here.
              </div>
            ) : (
              node.sessions.map(renderSession)
            )}
          </div>
        )}
      </div>
    );
  };

  const createFolderError = createFolderName ? folderNameError(createFolderName)
    ?? (allFolderPaths.includes(createFolderName.trim()) ? `"${createFolderName.trim()}" already exists.` : null) : null;
  const submitCreateFolder = () => {
    if (!createFolderName.trim() || createFolderError) return;
    createFolder(createFolderName.trim());
    setCreateFolderName('');
    setIsAddingFolder(false);
  };

  const moveInputError = newFolderInput ? folderNameError(newFolderInput) : null;

  return (
    <div 
      onContextMenu={(e) => e.preventDefault()}
      className="flex flex-col h-full bg-plinky-900 border-r border-plinky-800 select-none text-slate-200 relative"
    >
      {/* Sidebar Header */}
      <div className="px-3 py-2.5 border-b border-plinky-800 flex items-center justify-between gap-1">
        <div className="flex items-center space-x-1.5 min-w-0">
          <Terminal className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          {/* "PuTTY Sessions" never fit the 256 px sidebar: it showed as
              "PUTTY SESS...". The whole app is about PuTTY sessions. */}
          <span className="font-semibold text-[11px] tracking-wider uppercase text-slate-300 truncate whitespace-nowrap">
            Sessions
          </span>
        </div>
        <div className="flex items-center space-x-1 shrink-0">
          <button
            onClick={() => setIsAddingFolder(v => !v)}
            title="Create New Folder"
            aria-label="Create New Folder"
            className="p-1 rounded text-slate-400 hover:text-amber-300 hover:bg-plinky-800 transition shrink-0"
          >
            <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
          </button>
          <button
            onClick={() => onCreateSession()}
            title="Create New PuTTY Session"
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25 hover:border-sky-500/50 transition shrink-0 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="text-[11px] font-medium">New</span>
          </button>
        </div>
      </div>

      {/* Inline Create Folder Form (top level; right-click a folder for a subfolder) */}
      {isAddingFolder && (
        <div className="p-2 bg-plinky-950/90 border-b border-plinky-800 space-y-1">
          <div className="flex items-center space-x-1.5">
            <FolderPlus className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <input
              type="text"
              autoFocus
              placeholder="Folder name, Enter to create..."
              value={createFolderName}
              onChange={(e) => setCreateFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  submitCreateFolder();
                } else if (e.key === 'Escape') {
                  setIsAddingFolder(false);
                  setCreateFolderName('');
                }
              }}
              className="flex-1 bg-plinky-900 border border-plinky-700 rounded px-2 py-0.5 text-xs text-slate-200 placeholder-plinky-muted focus:outline-none focus:border-sky-500"
            />
            <button
              onClick={submitCreateFolder}
              disabled={!createFolderName.trim() || !!createFolderError}
              className="px-2 py-0.5 rounded bg-sky-700 hover:brightness-110 disabled:opacity-40 text-white text-[11px] font-medium"
            >
              Add
            </button>
            <button
              onClick={() => {
                setIsAddingFolder(false);
                setCreateFolderName('');
              }}
              className="p-0.5 rounded text-slate-400 hover:text-slate-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {createFolderError && <div role="alert" className="text-[11px] text-rose-400">{createFolderError}</div>}
        </div>
      )}

      {/* Search Bar */}
      <div className="p-2 border-b border-plinky-800/60">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 absolute left-2.5 text-plinky-muted pointer-events-none" />
          <input
            type="text"
            ref={searchRef}
            placeholder="Search sessions or tags"
            aria-label="Search sessions"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter opens the first match; Down steps into the tree.
              if (e.key === 'Enter') {
                const first = treeItems().find(el => el.dataset.sessionRow !== undefined);
                const match = first && sessions.find(x => x.name === first.dataset.sessionRow);
                if (match) { e.preventDefault(); onConnectSession(match, true); }
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                focusItem(treeItems()[0]);
              } else if (e.key === 'Escape' && searchQuery) {
                e.preventDefault();
                setSearchQuery('');
              }
            }}
            className="w-full pl-8 pr-3 py-1 bg-plinky-950 border border-plinky-700/80 rounded text-xs text-slate-200 placeholder-plinky-muted focus:outline-none focus:border-sky-500 transition"
          />
        </div>
      </div>

      {folderError && (
        <div role="alert" className="mx-2 mt-2 px-2 py-1.5 rounded border border-rose-500/40 bg-rose-500/10 text-[11px] text-rose-300 flex items-start gap-1.5">
          <span className="flex-1">{folderError}</span>
          <button onClick={() => setFolderError(null)} aria-label="Dismiss" className="text-rose-300/70 hover:text-rose-200">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Session Tree */}
      <div
        ref={treeRef}
        role="tree"
        aria-label="Sessions"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        // Tabbing in lands on the tree; hand focus to its first item.
        onFocus={(e) => { if (e.target === e.currentTarget) focusItem(treeItems()[0]); }}
        className="flex-1 overflow-y-auto p-2 space-y-3 outline-none"
      >
        {visibleTree.map(renderFolder)}

        {dragging?.kind === 'folder' && parentPath(dragging.path) !== '' && (
          <div
            {...dropHandlers('')}
            className={`py-2 px-2 text-center rounded border border-dashed transition text-[11px] ${
              dragOverFolder === ''
                ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                : 'border-plinky-700 text-plinky-muted'
            }`}
          >
            Drop here to move to the top level
          </div>
        )}

        {sessions.length === 0 && (
          <div className="flex flex-col items-center text-center py-10 px-4 space-y-3">
            <Terminal className="w-8 h-8 text-slate-600" />
            <div className="text-xs text-slate-400">No sessions yet</div>
            <button
              onClick={() => onCreateSession()}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25 hover:border-sky-500/50 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="text-xs font-medium">Create your first connection</span>
            </button>
          </div>
        )}

        {sessions.length > 0 && filteredSessions.length === 0 && (
          <div className="text-center py-8 text-plinky-muted text-xs">
            No PuTTY sessions matched "{searchQuery}"
          </div>
        )}
      </div>

      {/* Quick Status Bar */}
      {/* The footer's green "Native PuTTY" dot never changed: a status light
          with no status. The count stays; the search shortcut replaces it. */}
      <div className="px-2 py-1.5 border-t border-plinky-800 bg-plinky-950/50 flex items-center justify-between text-[11px] text-plinky-muted">
        <span>{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}</span>
        <kbd className="font-mono text-[11px] text-plinky-muted">Ctrl+Shift+O</kbd>
      </div>

      {/* Folder Context Menu */}
      {folderMenu && (() => {
        const node = folderMenu.node;
        const inFolder = collectSessions(node);
        const isDefault = node.path === DEFAULT_FOLDER;
        const item = 'w-full flex items-center space-x-2 px-3 py-1.5 text-slate-200 hover:text-white hover:bg-plinky-800 transition text-left disabled:opacity-40 disabled:hover:bg-transparent';
        return (
          <div
            role="menu"
            aria-label={`Folder ${node.path}`}
            style={{
              position: 'fixed',
              left: Math.min(folderMenu.x, window.innerWidth - 200),
              top: Math.min(folderMenu.y, window.innerHeight - 200),
            }}
            className="z-50 w-48 bg-plinky-950/95 backdrop-blur-sm border border-plinky-700/80 rounded-lg shadow-2xl py-1 text-xs select-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1 text-[11px] text-plinky-muted font-mono border-b border-plinky-800/80 truncate">
              {displayPath(node.path)}
            </div>
            <button
              className={item}
              onClick={() => {
                onCreateSession(node.path);
                setFolderMenu(null);
              }}
            >
              <Plus className="w-3.5 h-3.5 text-emerald-400" />
              <span>New Session Here...</span>
            </button>
            <button
              className={item}
              onClick={() => {
                if (collapsedFolders[node.path]) toggleFolder(node.path);
                setFolderEdit({ mode: 'new-sub', path: node.path, value: '' });
                setFolderMenu(null);
              }}
            >
              <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
              <span>New Subfolder...</span>
            </button>
            <button
              className={item}
              disabled={isDefault}
              title={isDefault ? `"${DEFAULT_FOLDER}" holds sessions with no folder and keeps its name.` : undefined}
              onClick={() => {
                setFolderEdit({ mode: 'rename', path: node.path, value: node.name });
                setFolderMenu(null);
              }}
            >
              <Pencil className="w-3.5 h-3.5 text-slate-400" />
              <span>Rename Folder...</span>
            </button>
            <button
              className={item}
              disabled={inFolder.length === 0}
              onClick={() => {
                setConfirmConnect({ path: node.path, sessions: inFolder });
                setFolderMenu(null);
              }}
            >
              <Play className="w-3.5 h-3.5 text-sky-400" />
              <span>Connect All ({inFolder.length})...</span>
            </button>
            {inFolder.length === 0 && !isDefault && (
              <button
                className={item}
                onClick={() => {
                  deleteFolder(node);
                  setFolderMenu(null);
                }}
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                <span>Delete Folder</span>
              </button>
            )}
          </div>
        );
      })()}

      {/* Connect All confirmation: a deep folder can hold dozens of sessions. */}
      {confirmConnect && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-plinky-950/50"
          onClick={() => setConfirmConnect(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setConfirmConnect(null); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Connect all sessions"
            className="w-80 bg-plinky-900 border border-plinky-700 rounded-lg shadow-2xl p-4 space-y-3 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-slate-200 font-semibold">
              Open {confirmConnect.sessions.length} session{confirmConnect.sessions.length === 1 ? '' : 's'}?
            </div>
            <div className="text-slate-400">
              Every session in "{displayPath(confirmConnect.path)}" and its subfolders opens in a new tab:
            </div>
            <ul className="max-h-40 overflow-y-auto font-mono text-[11px] text-slate-300 space-y-0.5 bg-plinky-950/60 rounded p-2">
              {confirmConnect.sessions.map(s => (
                <li key={s.name} className="truncate">{s.name}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => setConfirmConnect(null)}
                className="px-3 py-1 rounded border border-plinky-700 text-slate-300 hover:bg-plinky-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  for (const s of confirmConnect.sessions) onConnectSession(s, true);
                  setConfirmConnect(null);
                }}
                className="px-3 py-1 rounded bg-sky-700 hover:brightness-110 text-white font-medium"
              >
                Open {confirmConnect.sessions.length}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Context Menu */}
      {contextMenu && (
        <div
          role="menu"
          aria-label={`Session ${contextMenu.session.name}`}
          style={{ 
            position: 'fixed', 
            left: Math.min(contextMenu.x, window.innerWidth - 180), 
            top: Math.min(contextMenu.y, window.innerHeight - 150) 
          }}
          className="z-50 w-44 bg-plinky-950/95 backdrop-blur-sm border border-plinky-700/80 rounded-lg shadow-2xl py-1 text-xs select-none animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[11px] text-plinky-muted font-mono border-b border-plinky-800/80 truncate">
            {contextMenu.session.name}
          </div>
          <button
            onClick={() => {
              onConnectSession(contextMenu.session, true);
              setContextMenu(null);
            }}
            className="w-full flex items-center space-x-2 px-3 py-1.5 text-slate-200 hover:text-white hover:bg-sky-600/30 transition text-left"
          >
            <Terminal className="w-3.5 h-3.5 text-sky-400" />
            <span>Connect Terminal</span>
          </button>
          {contextMenu.session.protocol === 'SSH' && (
            <button
              onClick={() => {
                onOpenSftp(contextMenu.session);
                setContextMenu(null);
              }}
              className="w-full flex items-center space-x-2 px-3 py-1.5 text-slate-200 hover:text-white hover:bg-emerald-600/30 transition text-left"
            >
              <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
              <span>Open SFTP Pane</span>
            </button>
          )}
          <button
            onClick={() => {
              onEditSession(contextMenu.session);
              setContextMenu(null);
            }}
            className="w-full flex items-center space-x-2 px-3 py-1.5 text-slate-200 hover:text-white hover:bg-plinky-800 transition text-left"
          >
            <Pencil className="w-3.5 h-3.5 text-slate-400" />
            <span>Edit Session</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMoveSubmenuOpen(v => !v);
            }}
            className="w-full flex items-center space-x-2 px-3 py-1.5 text-slate-200 hover:text-white hover:bg-plinky-800 transition text-left"
          >
            <FolderInput className="w-3.5 h-3.5 text-amber-400" />
            <span className="flex-1">Move to Folder</span>
            <span className="text-plinky-muted">{moveSubmenuOpen ? '▾' : '▸'}</span>
          </button>
          {moveSubmenuOpen && (
            <div className="border-t border-b border-plinky-800/80 py-1">
              <div className="max-h-32 overflow-y-auto">
                {allFolderPaths
                  .filter(f => f !== sessionFolder(contextMenu.session))
                  .map(f => (
                    <button
                      key={f}
                      title={displayPath(f)}
                      onClick={() => {
                        onMoveToFolder(contextMenu.session, f);
                        setContextMenu(null);
                        setMoveSubmenuOpen(false);
                      }}
                      className="w-full flex items-center px-4 py-1 text-[11px] text-slate-300 hover:text-white hover:bg-sky-600/20 transition text-left truncate"
                    >
                      {displayPath(f)}
                    </button>
                  ))}
              </div>
              <div className="px-3 pt-1">
                <input
                  type="text"
                  value={newFolderInput}
                  onChange={(e) => setNewFolderInput(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newFolderInput.trim() && !moveInputError) {
                      const target = newFolderInput.trim();
                      addUserFolder(target);
                      onMoveToFolder(contextMenu.session, target);
                      setContextMenu(null);
                      setMoveSubmenuOpen(false);
                      setNewFolderInput('');
                      setFolderVersion(v => v + 1);
                    }
                  }}
                  placeholder="New folder name, Enter to create"
                  className="w-full bg-plinky-900 border border-plinky-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 placeholder-plinky-muted focus:outline-none focus:border-sky-500"
                />
                {moveInputError && <div role="alert" className="text-[11px] text-rose-400 pt-0.5">{moveInputError}</div>}
              </div>
            </div>
          )}
          <button
            onClick={() => {
              if (contextMenu.session.hostname) {
                navigator.clipboard.writeText(contextMenu.session.hostname);
              }
              setContextMenu(null);
            }}
            className="w-full flex items-center space-x-2 px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition text-left"
          >
            <Tag className="w-3.5 h-3.5 text-plinky-muted" />
            <span>Copy Hostname</span>
          </button>
        </div>
      )}
    </div>
  );
};
