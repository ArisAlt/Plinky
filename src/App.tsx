import React, { useState, useEffect } from 'react';
import { PuttySession, TerminalTab, SyncChannel } from './types/session';
import { listPuttySessions, writePuttySession } from './services/tauriBridge';
import { TitleBar } from './components/layout/TitleBar';
import { StatusBar } from './components/layout/StatusBar';
import { SessionExplorer } from './components/sidebar/SessionExplorer';
import { TerminalView } from './components/terminal/TerminalView';
import { SftpDualPane } from './components/sftp/SftpDualPane';
import { TunnelManager } from './components/tunnels/TunnelManager';
import { HostKeyManager } from './components/keys/HostKeyManager';
import { SyncBroadcastBar } from './components/sync/SyncBroadcastBar';
import { NewSessionModal } from './components/modals/NewSessionModal';
import { 
  X, 
  Plus, 
  Terminal, 
  Columns, 
  Rows, 
} from 'lucide-react';

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<PuttySession[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'sessions' | 'sftp' | 'tunnels' | 'keys'>('sessions');
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [sftpSession, setSftpSession] = useState<{ name: string; host: string }>({
    name: 'Production Cluster Alpha',
    host: '192.0.2.10',
  });

  // Load PuTTY sessions on startup
  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    const list = await listPuttySessions();
    setSessions(list);

    // If no tabs open, open the first session by default
    if (list.length > 0 && tabs.length === 0) {
      handleConnectSession(list[0]);
    }
  };

  const handleConnectSession = (session: PuttySession) => {
    const newTab: TerminalTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      title: session.name,
      sessionName: session.name,
      syncChannel: 'none',
      status: 'live',
      freeTypeMode: true,
      activeHighlighting: true,
      hostname: session.hostname || 'localhost',
      port: session.port || 22,
      username: session.username || 'deploy',
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setActiveView('sessions');
  };

  const handleQuickConnect = (host: string, port: number) => {
    const sessionName = `Quick (${host}:${port})`;
    const newTab: TerminalTab = {
      id: `tab-${Date.now()}`,
      title: sessionName,
      sessionName,
      syncChannel: 'none',
      status: 'live',
      freeTypeMode: true,
      activeHighlighting: true,
      hostname: host,
      port,
      username: 'root',
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setActiveView('sessions');
  };

  const handleOpenSftp = (session: PuttySession) => {
    setSftpSession({ name: session.name, host: session.hostname || '192.0.2.10' });
    setActiveView('sftp');
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const remaining = tabs.filter(t => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) {
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
  };

  const handleUpdateTab = (tabId: string, updates: Partial<TerminalTab>) => {
    setTabs(prev => prev.map(t => (t.id === tabId ? { ...t, ...updates } : t)));
  };

  const handleSaveSession = async (newSession: PuttySession) => {
    await writePuttySession(newSession);
    await loadSessions();
  };

  const activeTab = tabs.find(t => t.id === activeTabId);

  const getChannelColor = (ch: SyncChannel) => {
    switch (ch) {
      case 'A': return 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30';
      case 'B': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      case 'C': return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      case 'D': return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
      default: return 'text-slate-500';
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-plinky-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Application Title & Navigation */}
      <TitleBar
        onQuickConnect={handleQuickConnect}
        onNewSession={() => setIsNewSessionOpen(true)}
        activeView={activeView}
        setActiveView={setActiveView}
      />

      {/* Main Workspace (Sidebar + Workbench Viewport) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: PuTTY Session Explorer Sidebar */}
        <div className="w-64 flex-shrink-0 flex flex-col h-full">
          <SessionExplorer
            sessions={sessions}
            onConnectSession={handleConnectSession}
            onOpenSftp={handleOpenSftp}
            onCreateSession={() => setIsNewSessionOpen(true)}
          />
        </div>

        {/* Center: Main IDE Canvas */}
        <div className="flex-1 flex flex-col bg-plinky-950 overflow-hidden">
          {activeView === 'sessions' && (
            <>
              {/* Terminal Tabs Header Bar */}
              <div className="h-9 bg-plinky-900 border-b border-plinky-800 flex items-center justify-between px-2 select-none">
                <div className="flex items-center space-x-1 overflow-x-auto flex-1 h-full pt-1">
                  {tabs.map((tab) => {
                    const isActive = tab.id === activeTabId;
                    return (
                      <div
                        key={tab.id}
                        onClick={() => setActiveTabId(tab.id)}
                        className={`group relative flex items-center space-x-2 px-3 py-1 text-xs rounded-t border-t border-l border-r cursor-pointer transition max-w-[220px] ${
                          isActive
                            ? 'bg-plinky-950 border-plinky-800 text-sky-300 font-medium shadow-xs'
                            : 'bg-plinky-900/60 border-transparent text-slate-400 hover:text-slate-200 hover:bg-plinky-850'
                        }`}
                      >
                        <Terminal className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-sky-400' : 'text-slate-500'}`} />
                        <span className="truncate flex-1">{tab.title}</span>

                        {/* Channel Badge Indicator */}
                        {tab.syncChannel !== 'none' && (
                          <span className={`px-1 py-0.2 rounded border text-[9px] font-mono font-bold ${getChannelColor(tab.syncChannel)}`}>
                            {tab.syncChannel}
                          </span>
                        )}

                        <button
                          onClick={(e) => handleCloseTab(tab.id, e)}
                          title="Close Tab"
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-plinky-800 text-slate-500 hover:text-slate-200 transition"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}

                  {/* Add New Quick Tab Button */}
                  <button
                    onClick={() => {
                      if (sessions.length > 0) handleConnectSession(sessions[0]);
                    }}
                    title="Open Another Session Tab"
                    className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-plinky-800 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Right Tab Controls: Split & Layout */}
                <div className="flex items-center space-x-1 text-slate-500">
                  <button
                    onClick={() => {
                      if (activeTab) {
                        handleConnectSession({
                          name: `${activeTab.sessionName} (Split)`,
                          hostname: activeTab.hostname,
                          port: activeTab.port,
                          protocol: 'SSH',
                        });
                      }
                    }}
                    title="Split Terminal Vertically"
                    className="p-1 rounded hover:bg-plinky-800 hover:text-slate-300 transition"
                  >
                    <Columns className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (activeTab) {
                        handleConnectSession({
                          name: `${activeTab.sessionName} (Split)`,
                          hostname: activeTab.hostname,
                          port: activeTab.port,
                          protocol: 'SSH',
                        });
                      }
                    }}
                    title="Split Terminal Horizontally"
                    className="p-1 rounded hover:bg-plinky-800 hover:text-slate-300 transition"
                  >
                    <Rows className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Terminal Viewport */}
              <div className="flex-1 relative overflow-hidden bg-plinky-950">
                {activeTab ? (
                  <TerminalView
                    key={activeTab.id}
                    tab={activeTab}
                    onUpdateTab={handleUpdateTab}
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 text-xs space-y-2">
                    <Terminal className="w-8 h-8 text-slate-600" />
                    <span>No active terminal sessions</span>
                    <button
                      onClick={() => {
                        if (sessions.length > 0) handleConnectSession(sessions[0]);
                      }}
                      className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium transition"
                    >
                      Connect to {sessions[0]?.name || 'Server'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {activeView === 'sftp' && (
            <SftpDualPane
              sessionName={sftpSession.name}
              hostname={sftpSession.host}
            />
          )}

          {activeView === 'tunnels' && (
            <TunnelManager sessionName={activeTab?.sessionName || 'Default'} />
          )}

          {activeView === 'keys' && (
            <HostKeyManager />
          )}
        </div>
      </div>

      {/* Multi-Session Broadcast Sync Bar (WindTerm style) */}
      <SyncBroadcastBar />

      {/* Application Bottom Status Bar */}
      <StatusBar tabs={tabs} activeTabId={activeTabId} />

      {/* New Session Modal */}
      <NewSessionModal
        isOpen={isNewSessionOpen}
        onClose={() => setIsNewSessionOpen(false)}
        onSave={handleSaveSession}
      />
    </div>
  );
};
