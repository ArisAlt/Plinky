import React, { useState, useEffect } from 'react';
import { PuttySession, TerminalTab, SyncChannel, SplitLayoutMode } from './types/session';
import { listPuttySessions, writePuttySession, writeTerminalInput } from './services/tauriBridge';
import { TitleBar } from './components/layout/TitleBar';
import { StatusBar } from './components/layout/StatusBar';
import { SessionExplorer } from './components/sidebar/SessionExplorer';
import { TerminalView } from './components/terminal/TerminalView';
import { SftpDualPane } from './components/sftp/SftpDualPane';
import { TunnelManager } from './components/tunnels/TunnelManager';
import { HostKeyManager } from './components/keys/HostKeyManager';
import { VaultManager } from './components/vault/VaultManager';
import { SyncBroadcastBar } from './components/sync/SyncBroadcastBar';
import { QuickSnippetBar } from './components/snippets/QuickSnippetBar';
import { NewSessionModal } from './components/modals/NewSessionModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { saveLayout, loadLayout } from './services/layoutPersistence';
import { 
  X, 
  Plus, 
  Terminal, 
  Columns, 
  Rows, 
  Square,
  LayoutGrid
} from 'lucide-react';

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<PuttySession[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'sessions' | 'sftp' | 'tunnels' | 'keys' | 'vault'>('sessions');
  const [layoutMode, setLayoutMode] = useState<SplitLayoutMode>('single');
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<PuttySession | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [terminalFontFamily, setTerminalFontFamily] = useState<string>(
    '"MesloLGS Nerd Font", "MesloLGS NF", "FantasqueSansM Nerd Font", "JetBrainsMono Nerd Font", "JetBrains Mono", "FiraCode Nerd Font", "Fira Code", "DejaVu Sans Mono", monospace'
  );
  const [terminalFontSize, setTerminalFontSize] = useState<number>(13);
  const [terminalCursorStyle, setTerminalCursorStyle] = useState<'block' | 'bar' | 'underline'>('bar');
  const [sftpSession, setSftpSession] = useState<{ name: string; host: string; remotePath?: string }>({
    name: 'Production Cluster Alpha',
    host: '192.0.2.10',
    remotePath: '/var/www',
  });
  const [copyOnSelect, setCopyOnSelect] = useState<boolean>(() => {
    const saved = localStorage.getItem('plinky_copy_on_select');
    return saved !== null ? saved === 'true' : true;
  });
  const [rightClickAction, setRightClickAction] = useState<'paste' | 'contextMenu'>(() => {
    const saved = localStorage.getItem('plinky_right_click_action');
    return (saved === 'paste' || saved === 'contextMenu') ? saved : 'contextMenu';
  });

  const handleUpdateCopyOnSelect = (val: boolean) => {
    setCopyOnSelect(val);
    localStorage.setItem('plinky_copy_on_select', String(val));
  };

  const handleUpdateRightClickAction = (val: 'paste' | 'contextMenu') => {
    setRightClickAction(val);
    localStorage.setItem('plinky_right_click_action', val);
  };

  const handleDuplicateTab = (targetTab: TerminalTab) => {
    const newTab: TerminalTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      title: `${targetTab.sessionName} (Copy)`,
      sessionName: targetTab.sessionName,
      syncChannel: targetTab.syncChannel,
      status: 'live',
      freeTypeMode: targetTab.freeTypeMode,
      activeHighlighting: targetTab.activeHighlighting,
      hostname: targetTab.hostname,
      port: targetTab.port,
      username: targetTab.username,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleResetLayout = () => {
    localStorage.removeItem('plinky_workbench_layout_v1');
    setLayoutMode('single');
    if (tabs.length > 1) {
      setTabs([tabs[0]]);
      setActiveTabId(tabs[0].id);
    }
  };

  // Load PuTTY sessions and restored layout on startup
  useEffect(() => {
    loadSessions();
  }, []);

  // R1-R3: Auto-persist layout changes
  useEffect(() => {
    if (tabs.length > 0) {
      saveLayout(layoutMode, activeTabId, tabs);
    }
  }, [layoutMode, activeTabId, tabs]);

  const loadSessions = async () => {
    const list = await listPuttySessions();
    setSessions(list);

    // Check for saved layout first (R1-R3)
    const savedLayout = loadLayout();
    if (savedLayout && savedLayout.tabs.length > 0) {
      setLayoutMode(savedLayout.layoutMode);
      const restoredTabs: TerminalTab[] = savedLayout.tabs.map(t => ({
        id: t.id,
        title: t.title,
        sessionName: t.sessionName,
        syncChannel: t.syncChannel,
        status: 'live',
        freeTypeMode: false,
        activeHighlighting: true,
        hostname: t.hostname,
        port: t.port,
        username: t.username,
      }));
      setTabs(restoredTabs);
      setActiveTabId(savedLayout.activeTabId || restoredTabs[0]?.id || null);
    } else if (list.length > 0 && tabs.length === 0) {
      handleConnectSession(list[0]);
    }
  };

  const handleCwdChange = (cwd: string) => {
    // Synchronize SFTP panel remote directory (directory following)
    setSftpSession(prev => ({ ...prev, remotePath: cwd }));
  };

  const handleConnectSession = (session: PuttySession) => {
    // A session that's already open should be focused, not duplicated --
    // clicking Connect on an already-connected session previously just
    // appended another tab with no visible confirmation anything happened.
    const existing = tabs.find(t => t.sessionName === session.name);
    if (existing) {
      setActiveTabId(existing.id);
      setActiveView('sessions');
      return;
    }

    const newTab: TerminalTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      title: session.name,
      sessionName: session.name,
      syncChannel: 'none',
      status: 'live',
      freeTypeMode: false,
      activeHighlighting: true,
      hostname: session.hostname || 'localhost',
      port: session.port || 22,
      username: session.username || 'deploy',
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setActiveView('sessions');
  };

  const handleQuickConnect = (host: string, port: number, username?: string) => {
    const sessionName = `Quick (${host}:${port})`;
    const newTab: TerminalTab = {
      id: `tab-${Date.now()}`,
      title: sessionName,
      sessionName,
      syncChannel: 'none',
      status: 'live',
      freeTypeMode: false,
      activeHighlighting: true,
      hostname: host,
      port,
      username: username || undefined,
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
    if (remaining.length < 2 && layoutMode !== 'single') {
      setLayoutMode('single');
    }
  };

  const handleUpdateTab = (tabId: string, updates: Partial<TerminalTab>) => {
    setTabs(prev => prev.map(t => (t.id === tabId ? { ...t, ...updates } : t)));
  };

  const handleSaveSession = async (newSession: PuttySession) => {
    await writePuttySession(newSession);
    await loadSessions();
  };

  const handleEditSession = (session: PuttySession) => {
    setEditingSession(session);
    setIsNewSessionOpen(true);
  };

  const handleSplitPane = (direction: 'vertical' | 'horizontal') => {
    if (direction === 'vertical') {
      setLayoutMode('split-vertical');
    } else {
      setLayoutMode('split-horizontal');
    }

    if (tabs.length === 1 && activeTab) {
      // Automatically spawn a split session with the same session
      handleConnectSession({
        name: `${activeTab.sessionName} (Split)`,
        hostname: activeTab.hostname,
        port: activeTab.port,
        protocol: 'SSH',
      });
    }
  };

  const handleExecuteSnippet = (command: string) => {
    if (!activeTabId) return;
    writeTerminalInput(activeTabId, new TextEncoder().encode(command));
  };

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  const getChannelColor = (ch: SyncChannel) => {
    switch (ch) {
      case 'A': return 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30';
      case 'B': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      case 'C': return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      case 'D': return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
      default: return 'text-slate-500';
    }
  };

  // Determine tabs displayed in split views
  const splitTabs = tabs.length >= 2
    ? [activeTab, ...tabs.filter(t => t.id !== activeTab?.id)]
    : tabs;

  return (
    <div 
      onContextMenu={(e) => e.preventDefault()}
      className="h-screen w-screen flex flex-col bg-plinky-950 text-slate-100 overflow-hidden font-sans select-none"
    >
      {/* Top Application Title & Navigation */}
      <TitleBar
        onQuickConnect={handleQuickConnect}
        onNewSession={() => setIsNewSessionOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        activeView={activeView}
        setActiveView={setActiveView}
      />

      {/* Main Workspace (Sidebar + Workbench Viewport) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: PuTTY Session Explorer Sidebar */}
        <div className="w-64 flex-shrink-0 flex flex-col h-full">
          <SessionExplorer
            sessions={sessions}
            tabs={tabs}
            activeTabId={activeTabId}
            onConnectSession={handleConnectSession}
            onOpenSftp={handleOpenSftp}
            onCreateSession={() => setIsNewSessionOpen(true)}
            onEditSession={handleEditSession}
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

                {/* Right Tab Controls: Split & Multi-Pane Layout Selector */}
                <div className="flex items-center space-x-1 text-slate-400">
                  <button
                    onClick={() => setLayoutMode('single')}
                    title="Single Terminal View"
                    className={`p-1.5 rounded transition ${layoutMode === 'single' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40' : 'hover:bg-plinky-800 hover:text-slate-200'}`}
                  >
                    <Square className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleSplitPane('vertical')}
                    title="Split View Vertically (Side by Side)"
                    className={`p-1.5 rounded transition ${layoutMode === 'split-vertical' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40' : 'hover:bg-plinky-800 hover:text-slate-200'}`}
                  >
                    <Columns className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleSplitPane('horizontal')}
                    title="Split View Horizontally (Stacked)"
                    className={`p-1.5 rounded transition ${layoutMode === 'split-horizontal' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40' : 'hover:bg-plinky-800 hover:text-slate-200'}`}
                  >
                    <Rows className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setLayoutMode('grid-4');
                      while (tabs.length < 4 && sessions.length > 0) {
                        const nextSession = sessions[tabs.length % sessions.length];
                        handleConnectSession({
                          name: `${nextSession.name} (${tabs.length + 1})`,
                          hostname: nextSession.hostname,
                          port: nextSession.port,
                          protocol: nextSession.protocol,
                        });
                      }
                    }}
                    title="4-Terminal Cluster Grid (2x2)"
                    className={`p-1.5 rounded transition ${layoutMode === 'grid-4' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40' : 'hover:bg-plinky-800 hover:text-slate-200'}`}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Terminal Viewport (Single, Split, or Grid) */}
              <div className="flex-1 relative overflow-hidden bg-plinky-950 flex flex-col">
                {tabs.length === 0 ? (
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
                ) : layoutMode === 'single' ? (
                  <div className="flex-1 relative w-full h-full overflow-hidden">
                    <TerminalView
                      key={activeTab.id}
                      tab={activeTab}
                      onUpdateTab={handleUpdateTab}
                      onSplitPane={handleSplitPane}
                      onCwdChange={handleCwdChange}
                      onDuplicateTab={handleDuplicateTab}
                      onOpenSettings={() => setIsSettingsOpen(true)}
                      fontFamily={terminalFontFamily}
                      fontSize={terminalFontSize}
                      cursorStyle={terminalCursorStyle}
                      copyOnSelect={copyOnSelect}
                      rightClickAction={rightClickAction}
                    />
                  </div>
                ) : layoutMode === 'split-vertical' ? (
                  <div className="flex-1 flex w-full h-full overflow-hidden divide-x divide-plinky-800">
                    <div 
                      onClick={() => setActiveTabId(splitTabs[0].id)}
                      className={`flex-1 h-full relative ${activeTabId === splitTabs[0].id ? 'ring-1 ring-sky-500/50' : ''}`}
                    >
                      <TerminalView
                        key={splitTabs[0].id}
                        tab={splitTabs[0]}
                        onUpdateTab={handleUpdateTab}
                        onSplitPane={handleSplitPane}
                        onCwdChange={handleCwdChange}
                        onDuplicateTab={handleDuplicateTab}
                        onOpenSettings={() => setIsSettingsOpen(true)}
                        fontFamily={terminalFontFamily}
                        fontSize={terminalFontSize}
                        cursorStyle={terminalCursorStyle}
                        copyOnSelect={copyOnSelect}
                        rightClickAction={rightClickAction}
                      />
                    </div>
                    {splitTabs[1] ? (
                      <div 
                        onClick={() => setActiveTabId(splitTabs[1].id)}
                        className={`flex-1 h-full relative ${activeTabId === splitTabs[1].id ? 'ring-1 ring-sky-500/50' : ''}`}
                      >
                        <TerminalView
                          key={splitTabs[1].id}
                          tab={splitTabs[1]}
                          onUpdateTab={handleUpdateTab}
                          onSplitPane={handleSplitPane}
                          onCwdChange={handleCwdChange}
                          onDuplicateTab={handleDuplicateTab}
                          onOpenSettings={() => setIsSettingsOpen(true)}
                          fontFamily={terminalFontFamily}
                          fontSize={terminalFontSize}
                          cursorStyle={terminalCursorStyle}
                          copyOnSelect={copyOnSelect}
                          rightClickAction={rightClickAction}
                        />
                      </div>
                    ) : (
                      <div className="flex-1 h-full flex flex-col items-center justify-center bg-plinky-950 text-slate-500 text-xs space-y-2">
                        <Columns className="w-6 h-6 text-slate-600" />
                        <span>Empty Split View Pane</span>
                        <button
                          onClick={() => handleSplitPane('vertical')}
                          className="px-2.5 py-1 rounded bg-plinky-850 hover:bg-plinky-800 text-slate-300 border border-plinky-700"
                        >
                          + Open Split Tab
                        </button>
                      </div>
                    )}
                  </div>
                ) : layoutMode === 'split-horizontal' ? (
                  <div className="flex-1 flex flex-col w-full h-full overflow-hidden divide-y divide-plinky-800">
                    <div 
                       onClick={() => setActiveTabId(splitTabs[0].id)}
                      className={`flex-1 w-full relative ${activeTabId === splitTabs[0].id ? 'ring-1 ring-sky-500/50' : ''}`}
                    >
                      <TerminalView
                        key={splitTabs[0].id}
                        tab={splitTabs[0]}
                        onUpdateTab={handleUpdateTab}
                        onSplitPane={handleSplitPane}
                        onCwdChange={handleCwdChange}
                        onDuplicateTab={handleDuplicateTab}
                        onOpenSettings={() => setIsSettingsOpen(true)}
                        fontFamily={terminalFontFamily}
                        fontSize={terminalFontSize}
                        cursorStyle={terminalCursorStyle}
                        copyOnSelect={copyOnSelect}
                        rightClickAction={rightClickAction}
                      />
                    </div>
                    {splitTabs[1] ? (
                      <div 
                        onClick={() => setActiveTabId(splitTabs[1].id)}
                        className={`flex-1 w-full relative ${activeTabId === splitTabs[1].id ? 'ring-1 ring-sky-500/50' : ''}`}
                      >
                        <TerminalView
                          key={splitTabs[1].id}
                          tab={splitTabs[1]}
                          onUpdateTab={handleUpdateTab}
                          onSplitPane={handleSplitPane}
                          onCwdChange={handleCwdChange}
                          onDuplicateTab={handleDuplicateTab}
                          onOpenSettings={() => setIsSettingsOpen(true)}
                          fontFamily={terminalFontFamily}
                          fontSize={terminalFontSize}
                          cursorStyle={terminalCursorStyle}
                          copyOnSelect={copyOnSelect}
                          rightClickAction={rightClickAction}
                        />
                      </div>
                    ) : (
                      <div className="flex-1 w-full flex flex-col items-center justify-center bg-plinky-950 text-slate-500 text-xs space-y-2">
                        <Rows className="w-6 h-6 text-slate-600" />
                        <span>Empty Split View Pane</span>
                        <button
                          onClick={() => handleSplitPane('horizontal')}
                          className="px-2.5 py-1 rounded bg-plinky-850 hover:bg-plinky-800 text-slate-300 border border-plinky-700"
                        >
                          + Open Split Tab
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  /* 4-Pane Cluster Grid Layout */
                  <div className="flex-1 grid grid-cols-2 grid-rows-2 w-full h-full overflow-hidden divide-x divide-y divide-plinky-800">
                    {splitTabs.slice(0, 4).map((tab) => (
                      <div
                        key={tab.id}
                        onClick={() => setActiveTabId(tab.id)}
                        className={`relative w-full h-full overflow-hidden ${activeTabId === tab.id ? 'ring-1 ring-sky-500/50' : ''}`}
                      >
                        <TerminalView
                          tab={tab}
                          onUpdateTab={handleUpdateTab}
                          onSplitPane={handleSplitPane}
                          onCwdChange={handleCwdChange}
                          onDuplicateTab={handleDuplicateTab}
                          onOpenSettings={() => setIsSettingsOpen(true)}
                          fontFamily={terminalFontFamily}
                          fontSize={terminalFontSize}
                          cursorStyle={terminalCursorStyle}
                          copyOnSelect={copyOnSelect}
                          rightClickAction={rightClickAction}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Parameterized Quick Snippet Bar (WindTerm superpower) */}
              <QuickSnippetBar
                onExecuteSnippet={handleExecuteSnippet}
                activeSessionName={activeTab?.sessionName}
              />
            </>
          )}

          {activeView === 'sftp' && (
            <SftpDualPane
              sessionName={sftpSession.name}
              hostname={sftpSession.host}
              initialRemotePath={sftpSession.remotePath}
            />
          )}

          {activeView === 'tunnels' && (
            <TunnelManager sessionName={activeTab?.sessionName || 'Default'} />
          )}

          {activeView === 'keys' && (
            <HostKeyManager />
          )}

          {activeView === 'vault' && (
            <VaultManager />
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
        editingSession={editingSession}
        onClose={() => {
          setIsNewSessionOpen(false);
          setEditingSession(null);
        }}
        onSave={handleSaveSession}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        fontFamily={terminalFontFamily}
        onChangeFontFamily={setTerminalFontFamily}
        fontSize={terminalFontSize}
        onChangeFontSize={setTerminalFontSize}
        cursorStyle={terminalCursorStyle}
        onChangeCursorStyle={setTerminalCursorStyle}
        copyOnSelect={copyOnSelect}
        onChangeCopyOnSelect={handleUpdateCopyOnSelect}
        rightClickAction={rightClickAction}
        onChangeRightClickAction={handleUpdateRightClickAction}
        onResetLayout={handleResetLayout}
      />
    </div>
  );
};
