import React, { useState, useEffect } from 'react';
import { PuttySession, TerminalTab, SyncChannel, SplitLayoutMode } from './types/session';
import { listPuttySessions, writePuttySession, writeTerminalInput, closeTerminalSession } from './services/tauriBridge';
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
import { saveLayout, loadLayout, clearLayout } from './services/layoutPersistence';
import { 
  X, 
  Plus, 
  Terminal, 
  Columns, 
  Rows, 
  Square,
  LayoutGrid,
  Loader2,
  Key,
  FolderGit2
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
  // The session picked with a session's SFTP button. Without one, SFTP
  // follows the active terminal tab. (It used to default to a hardcoded
  // demo server, 192.0.2.10, that nobody could reach.)
  const [sftpPinned, setSftpPinned] = useState<{ name: string; host: string; port?: number; username?: string } | null>(null);
  // Each tab's last reported working directory (shell integration, OSC 7),
  // so SFTP can open where that tab's shell is.
  const [tabCwds, setTabCwds] = useState<Record<string, string>>({});
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
      status: 'connecting',
      freeTypeMode: targetTab.freeTypeMode,
      activeHighlighting: targetTab.activeHighlighting,
      hostname: targetTab.hostname,
      port: targetTab.port,
      username: targetTab.username,
      protocol: targetTab.protocol,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleResetLayout = () => {
    localStorage.removeItem('plinky_workbench_layout_v1');
    setLayoutMode('single');
    if (tabs.length > 1) {
      tabs.slice(1).forEach(t => closeTerminalSession(t.id));
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
    } else {
      clearLayout();
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
    }
    // No saved layout -> start with an empty workspace. Previously this
    // auto-connected to the first saved session, which meant the app
    // silently picked a session for you on every fresh start instead of
    // waiting for you to choose one.
  };

  const handleCwdChange = (tabId: string, cwd: string) => {
    setTabCwds(prev => (prev[tabId] === cwd ? prev : { ...prev, [tabId]: cwd }));
  };

  const handleConnectSession = (session: PuttySession, forceNew: boolean = false) => {
    // If not forcing a new connection and a tab already exists for this session,
    // switch focus to it. But if forceNew is requested (user clicked Connect button
    // or double-clicked), spawn a new session tab or duplicate.
    const existingMatches = tabs.filter(t => t.sessionName === session.name);
    if (!forceNew && existingMatches.length > 0) {
      setActiveTabId(existingMatches[0].id);
      setActiveView('sessions');
      return;
    }

    const title = existingMatches.length > 0
      ? `${session.name} (${existingMatches.length + 1})`
      : session.name;

    const newTab: TerminalTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      title,
      sessionName: session.name,
      syncChannel: 'none',
      status: 'connecting',
      freeTypeMode: false,
      activeHighlighting: true,
      hostname: session.hostname || session.host_name || '',
      port: session.port || session.port_number || 22,
      username: session.username || session.user_name || undefined,
      protocol: session.protocol,
      vaultKey: session.extra?.PlinkyVaultKey,
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
      status: 'connecting',
      freeTypeMode: false,
      activeHighlighting: true,
      hostname: host,
      port,
      username: username || undefined,
      protocol: 'SSH',
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setActiveView('sessions');
  };

  const handleOpenSftp = (session: PuttySession) => {
    setSftpPinned({
      name: session.name,
      host: session.hostname || session.host_name || '',
      port: session.port || session.port_number,
      username: session.username || session.user_name || undefined,
    });
    setActiveView('sftp');
  };

  // The top bar's SFTP button follows the active tab, not an old pick.
  const handleSetActiveView = (view: typeof activeView) => {
    if (view === 'sftp') setSftpPinned(null);
    setActiveView(view);
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Closing a tab is the only thing that ends its backend session --
    // TerminalView unmounting (tab switch, split re-render) just detaches.
    closeTerminalSession(id);
    const remaining = tabs.filter(t => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) {
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
    if (remaining.length === 0) {
      setLayoutMode('single');
    } else if (remaining.length < 2 && layoutMode !== 'single' && layoutMode !== 'terminal-sftp') {
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

  const handleMoveSessionToFolder = async (session: PuttySession, folder: string) => {
    if ((session.folder || 'Uncategorized') === folder) return;
    await writePuttySession({ 
      ...session, 
      folder,
      extra: { ...(session.extra || {}), PlinkyFolder: folder } 
    });
    await loadSessions();
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

  const renderTabStatusIcon = (tab: TerminalTab, isActive: boolean) => {
    switch (tab.status) {
      case 'connecting':
        return (
          <span title="Connecting to SSH host..." className="inline-flex items-center">
            <Loader2 className="w-3.5 h-3.5 flex-shrink-0 text-sky-400 animate-spin" />
          </span>
        );
      case 'preauth':
        return (
          <span title="Authentication / host key pending" className="inline-flex items-center">
            <Key className="w-3.5 h-3.5 flex-shrink-0 text-amber-400 animate-pulse" />
          </span>
        );
      case 'disconnected':
        return (
          <span
            className="w-2 h-2 rounded-full bg-rose-500/80 shrink-0 mx-0.5"
            title="Session disconnected"
          />
        );
      case 'live':
      default:
        return (
          <Terminal className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-sky-400' : 'text-slate-500'}`} />
        );
    }
  };

  // Tabs shown in split/grid panes, in stable tab order. Putting the active
  // tab first (as this used to) meant clicking the other pane swapped which
  // pane div each tab rendered in, remounting both terminals. The active
  // tab is still guaranteed a slot: if it's past the first n, it takes the
  // last one.
  const paneTabs = (n: number): TerminalTab[] => {
    const head = tabs.slice(0, n);
    if (!activeTab || head.some(t => t.id === activeTab.id)) return head;
    return [...head.slice(0, n - 1), activeTab];
  };
  const splitTabs = paneTabs(2);

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
        setActiveView={handleSetActiveView}
        sessions={sessions}
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
            onMoveToFolder={handleMoveSessionToFolder}
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
                        {renderTabStatusIcon(tab, isActive)}
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
                  <button
                    onClick={() => setLayoutMode(layoutMode === 'terminal-sftp' ? 'single' : 'terminal-sftp')}
                    title="Terminal + SFTP Side-by-Side Split"
                    className={`p-1.5 rounded transition ${layoutMode === 'terminal-sftp' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'hover:bg-plinky-800 hover:text-slate-200'}`}
                  >
                    <FolderGit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Terminal Viewport (Single, Split, Grid, or Terminal+SFTP) */}
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
                      onCwdChange={cwd => handleCwdChange(activeTab.id, cwd)}
                      onDuplicateTab={handleDuplicateTab}
                      onOpenSettings={() => setIsSettingsOpen(true)}
                      fontFamily={terminalFontFamily}
                      fontSize={terminalFontSize}
                      cursorStyle={terminalCursorStyle}
                      copyOnSelect={copyOnSelect}
                      rightClickAction={rightClickAction}
                    />
                  </div>
                ) : layoutMode === 'terminal-sftp' ? (
                  <div className="flex-1 flex w-full h-full overflow-hidden divide-x divide-plinky-800">
                    <div className="w-[58%] h-full relative">
                      <TerminalView
                        key={activeTab.id}
                        tab={activeTab}
                        onUpdateTab={handleUpdateTab}
                        onSplitPane={handleSplitPane}
                        onCwdChange={cwd => handleCwdChange(activeTab.id, cwd)}
                        onDuplicateTab={handleDuplicateTab}
                        onOpenSettings={() => setIsSettingsOpen(true)}
                        fontFamily={terminalFontFamily}
                        fontSize={terminalFontSize}
                        cursorStyle={terminalCursorStyle}
                        copyOnSelect={copyOnSelect}
                        rightClickAction={rightClickAction}
                      />
                    </div>
                    <div className="w-[42%] h-full relative overflow-hidden bg-plinky-950">
                      <SftpDualPane
                        sessionName={activeTab.sessionName}
                        hostname={activeTab.hostname}
                        port={activeTab.port}
                        username={activeTab.username}
                        initialRemotePath={tabCwds[activeTab.id]}
                      />
                    </div>
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
                        onCwdChange={cwd => handleCwdChange(splitTabs[0].id, cwd)}
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
                          onCwdChange={cwd => handleCwdChange(splitTabs[1].id, cwd)}
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
                        onCwdChange={cwd => handleCwdChange(splitTabs[0].id, cwd)}
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
                          onCwdChange={cwd => handleCwdChange(splitTabs[1].id, cwd)}
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
                    {paneTabs(4).map((tab) => (
                      <div
                        key={tab.id}
                        onClick={() => setActiveTabId(tab.id)}
                        className={`relative w-full h-full overflow-hidden ${activeTabId === tab.id ? 'ring-1 ring-sky-500/50' : ''}`}
                      >
                        <TerminalView
                          tab={tab}
                          onUpdateTab={handleUpdateTab}
                          onSplitPane={handleSplitPane}
                          onCwdChange={cwd => handleCwdChange(tab.id, cwd)}
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

          {activeView === 'sftp' && (sftpPinned ? (
            <SftpDualPane
              sessionName={sftpPinned.name}
              hostname={sftpPinned.host}
              port={sftpPinned.port}
              username={sftpPinned.username}
              onClose={() => setActiveView('sessions')}
            />
          ) : activeTab ? (
            <SftpDualPane
              sessionName={activeTab.sessionName}
              hostname={activeTab.hostname}
              port={activeTab.port}
              username={activeTab.username}
              initialRemotePath={tabCwds[activeTab.id]}
              onClose={() => setActiveView('sessions')}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-sm space-y-2">
              <p>No session to browse.</p>
              <p className="text-xs text-slate-500">Connect to a session, or use a saved session's SFTP button in the sidebar.</p>
              <button onClick={() => setActiveView('sessions')} className="mt-2 px-3 py-1 rounded bg-plinky-800 hover:bg-plinky-700 text-xs">Back</button>
            </div>
          ))}

          {activeView === 'tunnels' && (
            <TunnelManager 
              sessionName={activeTab?.sessionName || 'Default'} 
              onClose={() => setActiveView('sessions')}
            />
          )}

          {activeView === 'keys' && (
            <HostKeyManager onClose={() => setActiveView('sessions')} />
          )}

          {activeView === 'vault' && (
            <VaultManager onClose={() => setActiveView('sessions')} />
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
        savedSessions={sessions}
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
