import React, { useState } from 'react';
import { PuttySession, TerminalTab } from '../../types/session';
import {
  Folder,
  FolderInput,
  Terminal,
  Search,
  Plus,
  HardDrive,
  Tag,
  Pencil,
  List,
  LayoutList
} from 'lucide-react';

interface SessionExplorerProps {
  sessions: PuttySession[];
  tabs: TerminalTab[];
  activeTabId: string | null;
  onConnectSession: (session: PuttySession, forceNew?: boolean) => void;
  onOpenSftp: (session: PuttySession) => void;
  onCreateSession: () => void;
  onEditSession: (session: PuttySession) => void;
  onMoveToFolder: (session: PuttySession, folder: string) => void;
}

export const SessionExplorer: React.FC<SessionExplorerProps> = ({
  sessions,
  tabs,
  activeTabId,
  onConnectSession,
  onOpenSftp,
  onCreateSession,
  onEditSession,
  onMoveToFolder,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; session: PuttySession } | null>(null);
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);
  const [newFolderInput, setNewFolderInput] = useState('');
  const [draggingSession, setDraggingSession] = useState<PuttySession | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
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
      setMoveSubmenuOpen(false);
      setNewFolderInput('');
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  const toggleFolder = (folder: string) => {
    setCollapsedFolders(prev => ({ ...prev, [folder]: !prev[folder] }));
  };

  // All folder names that exist across saved sessions (not just the
  // currently filtered ones), so the "Move to Folder" list stays complete
  // while searching.
  const allFolders = Array.from(new Set(sessions.map(s => s.folder || 'Uncategorized'))).sort();

  const filteredSessions = sessions.filter(s => {
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
  });

  // Group by folder
  const groupedSessions = filteredSessions.reduce<Record<string, PuttySession[]>>((acc, s) => {
    const folder = s.folder || 'Uncategorized';
    if (!acc[folder]) acc[folder] = [];
    acc[folder].push(s);
    return acc;
  }, {});

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

  return (
    <div 
      onContextMenu={(e) => e.preventDefault()}
      className="flex flex-col h-full bg-plinky-900 border-r border-plinky-800 select-none text-slate-200 relative"
    >
      {/* Sidebar Header */}
      <div className="p-3 border-b border-plinky-800 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Terminal className="w-4 h-4 text-sky-400" />
          <span className="font-semibold text-xs tracking-wider uppercase text-slate-300">PuTTY Sessions</span>
        </div>
        <div className="flex items-center space-x-1">
          <button
            onClick={toggleDensity}
            title={density === 'compact' ? 'Switch to Comfortable View (Cards)' : 'Switch to Compact View (List)'}
            aria-label="Toggle view density"
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition"
          >
            {density === 'compact' ? <LayoutList className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onCreateSession}
            title="Create New PuTTY Session"
            className="flex items-center space-x-1 px-2 py-1 rounded bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25 hover:border-sky-500/50 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="text-[11px] font-medium">New</span>
          </button>
        </div>
      </div>

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

      {/* Session Tree */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {Object.entries(groupedSessions).map(([folder, folderSessions]) => {
          const isCollapsed = collapsedFolders[folder];
          return (
            <div key={folder} className="space-y-1">
              {/* Folder Header -- also a drop target for dragged sessions */}
              <button
                onClick={() => toggleFolder(folder)}
                onDragOver={(e) => {
                  if (!draggingSession) return;
                  e.preventDefault();
                  setDragOverFolder(folder);
                }}
                onDragLeave={() => setDragOverFolder(prev => (prev === folder ? null : prev))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverFolder(null);
                  if (draggingSession) {
                    onMoveToFolder(draggingSession, folder);
                    setDraggingSession(null);
                  }
                }}
                title={draggingSession ? `Drop to move into "${folder}"` : undefined}
                className={`w-full flex items-center space-x-1.5 px-1 py-1 rounded text-xs font-medium transition text-left ${
                  dragOverFolder === folder
                    ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/50'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/50'
                }`}
              >
                <Folder className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? '-rotate-90 text-slate-500' : 'text-sky-400'}`} />
                <span className="flex-1 truncate">{folder}</span>
                <span className="text-[10px] text-slate-500 font-mono">({folderSessions.length})</span>
              </button>

              {/* Folder Items */}
              {!isCollapsed && (
                <div className={`ml-3 pl-2 border-l border-plinky-800/80 ${density === 'compact' ? 'space-y-0.5' : 'space-y-1.5'}`}>
                  {folderSessions.map((session) => {
                    const openTab = tabs.find(t => t.sessionName === session.name);
                    const isActiveTab = !!openTab && openTab.id === activeTabId;
                    return density === 'compact' ? (
                      <div
                        key={session.name}
                        draggable
                        onDragStart={(e) => {
                          setDraggingSession(session);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => {
                          setDraggingSession(null);
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
                          <span className="truncate max-w-[100px] font-mono text-[10px] text-slate-500">
                            {session.hostname ? `${session.hostname}:${session.port}` : 'Local'}
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
                        setDraggingSession(session);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => {
                        setDraggingSession(null);
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
                        </div>
                        {getProtocolBadge(session.protocol)}
                      </div>

                      <div className="flex items-center justify-between mt-1.5 text-[11px] text-slate-400">
                        <span className="truncate max-w-[120px] font-mono text-[10px]">
                          {session.hostname ? `${session.hostname}:${session.port}` : 'Local Shell'}
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
                  })}
                </div>
              )}
            </div>
          );
        })}

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
                {allFolders
                  .filter(f => f !== (contextMenu.session.folder || 'Uncategorized'))
                  .map(f => (
                    <button
                      key={f}
                      onClick={() => {
                        onMoveToFolder(contextMenu.session, f);
                        setContextMenu(null);
                        setMoveSubmenuOpen(false);
                      }}
                      className="w-full flex items-center px-4 py-1 text-[11px] text-slate-300 hover:text-white hover:bg-sky-600/20 transition text-left truncate"
                    >
                      {f}
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
                    if (e.key === 'Enter' && newFolderInput.trim()) {
                      onMoveToFolder(contextMenu.session, newFolderInput.trim());
                      setContextMenu(null);
                      setMoveSubmenuOpen(false);
                      setNewFolderInput('');
                    }
                  }}
                  placeholder="New folder name, Enter to create"
                  className="w-full bg-plinky-900 border border-plinky-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                />
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
