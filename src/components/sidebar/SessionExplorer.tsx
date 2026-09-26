import React, { useState } from 'react';
import { PuttySession, TerminalTab } from '../../types/session';
import {
  Folder,
  FolderInput,
  FolderPlus,
  Terminal,
  Search,
  Plus,
  HardDrive,
  Tag,
  Pencil,
  List,
  LayoutList,
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
  onCreateSession: () => void;
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
  const [density, setDensity] = useState<'compact' | 'comfortable'>(() => {
    return (localStorage.getItem('plinky_session_tree_density') as 'compact' | 'comfortable') || 'comfortable';
  });

  const toggleDensity = () => {
    const next = density === 'comfortable' ? 'compact' : 'comfortable';
    setDensity(next);
    localStorage.setItem('plinky_session_tree_density', next);
  };

  React.useEffect(() => {
    const handleOutsideClick = () => {
      setContextMenu(null);
      setFolderMenu(null);
      setMoveSubmenuOpen(false);
      setNewFolderInput('');
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
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
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-sky-500/20 text-sky-400">SSH</span>;
      case 'Serial':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-500/20 text-purple-400">COM</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-700 text-slate-300">{protocol}</span>;
    }
  };

  const renderSession = (session: PuttySession) => {
    const openTab = tabs.find(t => t.sessionName === session.name);
    const isActiveTab = !!openTab && openTab.id === activeTabId;
    return density === 'compact' ? (
      <div
        key={session.name}
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
          setContextMenu({ x: e.clientX, y: e.clientY, session });
        }}
        title={openTab ? 'Double-click, or right-click -> Connect, to open another tab. Drag to move between folders.' : 'Double-click, or right-click -> Connect. Drag to move between folders.'}
        className={`group flex items-center justify-between px-2 py-1 rounded border cursor-pointer transition select-none text-xs ${
          isActiveTab
            ? 'bg-sky-500/10 border-sky-500/60'
            : openTab
            ? 'bg-plinky-800/50 border-plinky-700 hover:border-sky-500/50'
            : 'bg-plinky-950/40 hover:bg-plinky-800/80 border-plinky-800/50 hover:border-sky-500/40'
        }`}
      >
        <div className="flex items-center space-x-1.5 flex-1 min-w-0">
          {openTab ? (
            <span
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${isActiveTab ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-500/60'}`}
              title={isActiveTab ? 'Connected -- this is the active tab' : 'Connected -- open in another tab'}
            />
          ) : (
            <Terminal className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          )}
          <span className="font-semibold text-xs text-slate-100 truncate group-hover:text-sky-300 transition">
            {session.name}
          </span>
          {session.extra?.PlinkyVaultKey && (
            <span title={`Encrypted Vault Credential: ${session.extra.PlinkyVaultKey}`} className="inline-flex items-center">
              <Lock className="w-2.5 h-2.5 text-amber-400 shrink-0" />
            </span>
          )}
          <span className="truncate max-w-[100px] font-mono text-[10px] text-slate-500">
            {session.hostname
              ? `${session.hostname}:${session.port}`
              : session.name === 'Local Shell' ? 'Local' : 'no host'}
          </span>
        </div>

        <div className="flex items-center space-x-1 shrink-0 ml-1">
          {session.protocol === 'SSH' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSftp(session);
              }}
              title="Open Dual-Pane SFTP"
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-emerald-400 hover:bg-emerald-500/20 transition"
            >
              <HardDrive className="w-2.5 h-2.5" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEditSession(session);
            }}
            title="Edit Session Settings"
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-700 transition"
          >
            <Pencil className="w-2.5 h-2.5" />
          </button>
          {getProtocolBadge(session.protocol)}
        </div>
      </div>
    ) : (
    <div
      key={session.name}
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
        setContextMenu({ x: e.clientX, y: e.clientY, session });
      }}
      title={openTab ? 'Double-click, or right-click -> Connect, to open another tab. Drag to move between folders.' : 'Double-click, or right-click -> Connect. Drag to move between folders.'}
      className={`group flex flex-col p-2 rounded border cursor-pointer transition select-none shadow-xs ${
        isActiveTab
          ? 'bg-sky-500/10 border-sky-500/60'
          : openTab
          ? 'bg-plinky-800/50 border-plinky-700 hover:border-sky-500/50'
          : 'bg-plinky-950/60 hover:bg-plinky-800/90 border-plinky-800/70 hover:border-sky-500/50'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-1.5 flex-1 min-w-0">
          {openTab ? (
            <span
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${isActiveTab ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-500/60'}`}
              title={isActiveTab ? 'Connected -- this is the active tab' : 'Connected -- open in another tab'}
            />
          ) : (
            <Terminal className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          )}
          <span className="font-semibold text-xs text-slate-100 truncate group-hover:text-sky-300 transition">
            {session.name}
          </span>
          {session.extra?.PlinkyVaultKey && (
            <span title={`Encrypted Vault Credential: ${session.extra.PlinkyVaultKey}`} className="inline-flex items-center">
              <Lock className="w-3 h-3 text-amber-400 shrink-0" />
            </span>
          )}
        </div>
        {getProtocolBadge(session.protocol)}
      </div>

      <div className="flex items-center justify-between mt-1.5 text-[11px] text-slate-400">
        <span className="truncate max-w-[120px] font-mono text-[10px]">
          {session.hostname
            ? `${session.hostname}:${session.port}`
            : session.name === 'Local Shell' ? 'Local Shell' : 'No host set'}
        </span>

        <div className="flex items-center space-x-1">
          {session.protocol === 'SSH' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSftp(session);
              }}
              title="Open Dual-Pane SFTP"
              className="p-1 rounded bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-400 border border-emerald-500/30 transition"
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
            title="Edit Session Settings"
            className="p-1 rounded bg-plinky-800 hover:bg-plinky-700 text-slate-400 hover:text-slate-200 border border-plinky-700 transition"
          >
            <Pencil className="w-3 h-3" />
          </button>
        </div>
      </div>

      {session.tags && session.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {session.tags.map(t => (
            <span key={t} className="flex items-center space-x-0.5 text-[9px] px-1 py-0.2 rounded bg-slate-800 text-slate-400">
              <Tag className="w-2 h-2 text-slate-500" />
              <span>{t}</span>
            </span>
          ))}
        </div>
      )}
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
          className={`w-full bg-plinky-900 border rounded px-1.5 py-0.5 text-[11px] text-slate-200 placeholder-slate-500 focus:outline-none ${
            error && edit.value ? 'border-rose-500/70' : 'border-plinky-700 focus:border-sky-500'
          }`}
        />
        {error && edit.value && <div role="alert" className="text-[10px] text-rose-400 px-0.5">{error}</div>}
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
            title={dragging ? `Drop to move into "${displayPath(node.path)}"` : 'Right-click for folder actions. Drag to move.'}
            className={`w-full flex items-center space-x-1.5 px-1 py-1 rounded text-xs font-medium transition text-left ${
              dragOverFolder === node.path
                ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/50'
                : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/50'
            }`}
          >
            <Folder className={`w-3.5 h-3.5 shrink-0 transition-transform ${isCollapsed ? '-rotate-90 text-slate-500' : 'text-sky-400'}`} />
            <span className="flex-1 truncate">{node.name}</span>
            <span className="text-[10px] text-slate-500 font-mono">({total})</span>
            {total === 0 && !isDefault && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  deleteFolder(node);
                }}
                title="Delete empty folder"
                className="p-0.5 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition"
              >
                <Trash2 className="w-3 h-3" />
              </span>
            )}
          </button>
        )}

        {!isCollapsed && (
          <div className={`ml-3 pl-2 border-l border-plinky-800/80 ${density === 'compact' ? 'space-y-0.5' : 'space-y-1.5'}`}>
            {addingSub && renderFolderEditor(folderEdit)}
            {node.children.map(renderFolder)}
            {isEmpty && !addingSub ? (
              <div
                {...dropHandlers(node.path)}
                className={`py-2 px-2 my-1 text-center rounded border border-dashed transition text-[10px] ${
                  dragOverFolder === node.path
                    ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                    : 'border-plinky-800/80 text-slate-500 hover:border-slate-700'
                }`}
              >
                Empty folder — drag sessions here
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
          <span className="font-semibold text-xs tracking-wider uppercase text-slate-300 truncate whitespace-nowrap">
            PuTTY Sessions
          </span>
        </div>
        <div className="flex items-center space-x-1 shrink-0">
          <button
            onClick={toggleDensity}
            title={density === 'compact' ? 'Switch to Comfortable View (Cards)' : 'Switch to Compact View (List)'}
            aria-label="Toggle view density"
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition shrink-0"
          >
            {density === 'compact' ? <LayoutList className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setIsAddingFolder(v => !v)}
            title="Create New Folder"
            aria-label="Create New Folder"
            className="p-1 rounded text-slate-400 hover:text-amber-300 hover:bg-plinky-800 transition shrink-0"
          >
            <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
          </button>
          <button
            onClick={onCreateSession}
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
              className="flex-1 bg-plinky-900 border border-plinky-700 rounded px-2 py-0.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500"
            />
            <button
              onClick={submitCreateFolder}
              disabled={!createFolderName.trim() || !!createFolderError}
              className="px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-[11px] font-medium"
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
          {createFolderError && <div role="alert" className="text-[10px] text-rose-400">{createFolderError}</div>}
        </div>
      )}

      {/* Search Bar */}
      <div className="p-2 border-b border-plinky-800/60">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 absolute left-2.5 text-slate-500 pointer-events-none" />
          <input
            type="text"
            placeholder="Search sessions or tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1 bg-plinky-950 border border-plinky-700/80 rounded text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition"
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
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {visibleTree.map(renderFolder)}

        {dragging?.kind === 'folder' && parentPath(dragging.path) !== '' && (
          <div
            {...dropHandlers('')}
            className={`py-2 px-2 text-center rounded border border-dashed transition text-[10px] ${
              dragOverFolder === ''
                ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                : 'border-plinky-700 text-slate-500'
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
              onClick={onCreateSession}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25 hover:border-sky-500/50 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="text-xs font-medium">Create your first connection</span>
            </button>
          </div>
        )}

        {sessions.length > 0 && filteredSessions.length === 0 && (
          <div className="text-center py-8 text-slate-500 text-xs">
            No PuTTY sessions matched "{searchQuery}"
          </div>
        )}
      </div>

      {/* Quick Status Bar */}
      <div className="p-2 border-t border-plinky-800 bg-plinky-950/50 flex items-center justify-between text-[11px] text-slate-400">
        <span>{sessions.length} PuTTY sessions</span>
        <span className="text-emerald-400 flex items-center space-x-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
          <span>Native PuTTY</span>
        </span>
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
              top: Math.min(folderMenu.y, window.innerHeight - 170),
            }}
            className="z-50 w-48 bg-plinky-950/95 backdrop-blur-sm border border-plinky-700/80 rounded-lg shadow-2xl py-1 text-xs select-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1 text-[10px] text-slate-500 font-mono border-b border-plinky-800/80 truncate">
              {displayPath(node.path)}
            </div>
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
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
                className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium"
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
          style={{ 
            position: 'fixed', 
            left: Math.min(contextMenu.x, window.innerWidth - 180), 
            top: Math.min(contextMenu.y, window.innerHeight - 150) 
          }}
          className="z-50 w-44 bg-plinky-950/95 backdrop-blur-sm border border-plinky-700/80 rounded-lg shadow-2xl py-1 text-xs select-none animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] text-slate-500 font-mono border-b border-plinky-800/80 truncate">
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
            <span className="text-slate-500">{moveSubmenuOpen ? '▾' : '▸'}</span>
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
                  className="w-full bg-plinky-900 border border-plinky-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                />
                {moveInputError && <div role="alert" className="text-[10px] text-rose-400 pt-0.5">{moveInputError}</div>}
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
            <Tag className="w-3.5 h-3.5 text-slate-500" />
            <span>Copy Hostname</span>
          </button>
        </div>
      )}
    </div>
  );
};
