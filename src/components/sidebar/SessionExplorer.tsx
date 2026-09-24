import React, { useState } from 'react';
import { PuttySession } from '../../types/session';
import { 
  Folder, 
  Terminal, 
  Search, 
  Plus, 
  HardDrive, 
  Tag
} from 'lucide-react';

interface SessionExplorerProps {
  sessions: PuttySession[];
  onConnectSession: (session: PuttySession) => void;
  onOpenSftp: (session: PuttySession) => void;
  onCreateSession: () => void;
}

export const SessionExplorer: React.FC<SessionExplorerProps> = ({
  sessions,
  onConnectSession,
  onOpenSftp,
  onCreateSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const toggleFolder = (folder: string) => {
    setCollapsedFolders(prev => ({ ...prev, [folder]: !prev[folder] }));
  };

  const filteredSessions = sessions.filter(s => {
    const q = searchQuery.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.hostname.toLowerCase().includes(q) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(q))) ||
      (s.folder && s.folder.toLowerCase().includes(q))
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
    <div className="flex flex-col h-full bg-plinky-900 border-r border-plinky-800 select-none text-slate-200">
      {/* Sidebar Header */}
      <div className="p-3 border-b border-plinky-800 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Terminal className="w-4 h-4 text-sky-400" />
          <span className="font-semibold text-xs tracking-wider uppercase text-slate-300">PuTTY Sessions</span>
        </div>
        <div className="flex items-center space-x-1">
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
              {/* Folder Header */}
              <button
                onClick={() => toggleFolder(folder)}
                className="w-full flex items-center space-x-1.5 px-1 py-1 rounded text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-plinky-800/50 transition text-left"
              >
                <Folder className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? '-rotate-90 text-slate-500' : 'text-sky-400'}`} />
                <span className="flex-1 truncate">{folder}</span>
                <span className="text-[10px] text-slate-500 font-mono">({folderSessions.length})</span>
              </button>

              {/* Folder Items */}
              {!isCollapsed && (
                <div className="ml-3 pl-2 border-l border-plinky-800/80 space-y-1">
                  {folderSessions.map((session) => (
                    <div
                      key={session.name}
                      className="group flex flex-col p-1.5 rounded hover:bg-plinky-800 border border-transparent hover:border-plinky-700 transition"
                    >
                      <div className="flex items-center justify-between">
                        <span 
                          onClick={() => onConnectSession(session)}
                          className="font-medium text-xs text-slate-200 truncate cursor-pointer hover:text-sky-300 flex-1"
                        >
                          {session.name}
                        </span>
                        {getProtocolBadge(session.protocol)}
                      </div>

                      <div className="flex items-center justify-between mt-1 text-[11px] text-slate-400">
                        <span className="truncate max-w-[120px]">
                          {session.hostname ? `${session.hostname}:${session.port}` : 'Default config'}
                        </span>

                        <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1 transition">
                          <button
                            onClick={() => onConnectSession(session)}
                            title="Open Terminal"
                            className="p-1 rounded bg-sky-500/20 text-sky-400 hover:bg-sky-500/40 transition"
                          >
                            <Terminal className="w-3 h-3" />
                          </button>
                          {session.protocol === 'SSH' && (
                            <button
                              onClick={() => onOpenSftp(session)}
                              title="Open Dual-Pane SFTP"
                              className="p-1 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/40 transition"
                            >
                              <HardDrive className="w-3 h-3" />
                            </button>
                          )}
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
                  ))}
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
    </div>
  );
};
