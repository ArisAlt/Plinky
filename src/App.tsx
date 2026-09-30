import React, { useState, useEffect, useRef } from 'react';
import { PuttySession, TerminalTab, SyncChannel, SplitLayoutMode } from './types/session';
import { listPuttySessions, writePuttySession, writeTerminalInput, closeTerminalSession, SHOW_HOST_KEYS_EVENT, takeOpenRequests, listenOpenRequests, startSessionInBackground, OpenRequest, listenSessionConnected, isSessionConnected, listenSessionEnded, isSessionEnded } from './services/tauriBridge';
import { tabForOpenRequest, throttle } from './services/cliOpen';
import { terminalManager } from './services/terminalManager';
import { TitleBar } from './components/layout/TitleBar';
import { StatusBar } from './components/layout/StatusBar';
import { SessionExplorer } from './components/sidebar/SessionExplorer';
import { TerminalView } from './components/terminal/TerminalView';
import { SftpDualPane } from './components/sftp/SftpDualPane';
import { TunnelManager } from './components/tunnels/TunnelManager';
import { HostKeyManager } from './components/keys/HostKeyManager';
import { VaultManager } from './components/vault/VaultManager';
import { DEFAULT_TERMINAL_FONT, loadTerminalFont } from './themes/fonts';
import { ConfirmHost } from './components/common/ConfirmHost';
import { PasteConfirmHost } from './components/common/PasteConfirmHost';
import { askConfirm } from './services/confirm';
import { appShortcut, AppShortcut } from './services/shortcuts';
import { TooltipHost } from './components/common/TooltipHost';
import { SyncBroadcastBar } from './components/sync/SyncBroadcastBar';
import { QuickSnippetBar } from './components/snippets/QuickSnippetBar';
import { NewSessionModal } from './components/modals/NewSessionModal';
import { TabLauncher } from './components/layout/TabLauncher';
import { TabTitle } from './components/layout/TabTitle';
import { getRecentSessions, recordRecentSession } from './services/recentSessions';
import { useBroadcastGlow, glowColor } from './services/broadcast';
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
  // The session tree's width, dragged by its right edge and remembered. It
  // was a fixed 256 px: long session names had nowhere to go.
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 480;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('plinky_sidebar_width'));
      if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) return saved;
    } catch { /* storage unavailable: default width */ }
    return 256;
  });
  const startSidebarResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let width = startWidth;
    const move = (ev: PointerEvent) => {
      width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setSidebarWidth(width);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      try { localStorage.setItem('plinky_sidebar_width', String(width)); } catch { /* not remembered */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  // Console tabs from the command line (T-020) open only after startup has
  // restored the saved layout, which replaces the tab list.
  const [startupDone, setStartupDone] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'sessions' | 'sftp' | 'tunnels' | 'keys' | 'vault'>('sessions');
  const [layoutMode, setLayoutMode] = useState<SplitLayoutMode>('single');
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  // Tab bar (T-011): the "+" launcher, renaming, and a tab's right-click menu.
  const [launcherAnchor, setLauncherAnchor] = useState<{ top: number; left: number } | null>(null);
  const [recentNames, setRecentNames] = useState<string[]>(() => getRecentSessions());
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  // Tabs a sync broadcast just reached: in single-pane view the panes that
  // light up are hidden, so the tabs light up too (T-012).
  const broadcastLit = useBroadcastGlow();
  const [editingSession, setEditingSession] = useState<PuttySession | null>(null);
  // The folder a new session starts in, when created from a folder's menu.
  const [newSessionFolder, setNewSessionFolder] = useState<string | undefined>(undefined);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // Font and size were forgotten at every restart. Saved now; 14px by
  // default, one step up from 13, which read soft on Linux.
  const [terminalFontFamily, setFontFamilyState] = useState<string>(() => {
    try { return localStorage.getItem('plinky_terminal_font') || DEFAULT_TERMINAL_FONT; } catch { return DEFAULT_TERMINAL_FONT; }
  });
  const [terminalFontSize, setFontSizeState] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem('plinky_terminal_font_size'));
      return n >= 8 && n <= 32 ? n : 14;
    } catch { return 14; }
  });
  const setTerminalFontFamily = (stack: string) => {
    try { localStorage.setItem('plinky_terminal_font', stack); } catch { /* not remembered */ }
    // Load the face first: xterm measures its cell when the option changes,
    // and a face still downloading would be measured as the fallback.
    void loadTerminalFont(stack, terminalFontSize).then(() => setFontFamilyState(stack));
  };
  const setTerminalFontSize = (n: number) => {
    try { localStorage.setItem('plinky_terminal_font_size', String(n)); } catch { /* not remembered */ }
    setFontSizeState(n);
  };
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
      vaultKey: targetTab.vaultKey,
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

  // The list only. loadSessions also restores the saved tab layout, which
  // must happen once at startup, not after every delete or duplicate.
  const reloadSessions = async () => setSessions(await listPuttySessions());

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
        // A GNS3 console reconnects as telnet, not SSH to a telnet port.
        protocol: t.protocol as TerminalTab['protocol'],
      }));
      setTabs(restoredTabs);
      setActiveTabId(savedLayout.activeTabId || restoredTabs[0]?.id || null);
    }
    // No saved layout -> start with an empty workspace. Previously this
    // auto-connected to the first saved session, which meant the app
    // silently picked a session for you on every fresh start instead of
    // waiting for you to choose one.
    setStartupDone(true);
  };

  // A telnet or raw console is ready once its connection is up (the backend
  // watches plink's socket). A tab on screen hears that in its own view; one
  // behind it has no view yet, so it is marked here. Without this, after
  // GNS3's "console to all nodes" every tab but the front one kept its
  // "connecting" spinner although connected, until clicked (e2e suite). SSH
  // is not ready until its login is over, which only its view can tell.
  const markConnected = (id: string) => {
    setTabs(prev => prev.map(t => (
      t.id === id && t.status === 'connecting' && (t.protocol === 'Telnet' || t.protocol === 'RAW')
        ? { ...t, status: 'live' }
        : t
    )));
  };
  // And one whose plink exited before connecting (refused, unreachable) is
  // disconnected: behind the front tab it kept spinning "connecting".
  const markEnded = (id: string) => {
    setTabs(prev => prev.map(t => (t.id === id && t.status === 'connecting' ? { ...t, status: 'disconnected' } : t)));
  };
  useEffect(() => {
    let disposed = false;
    const unlisten: (() => void)[] = [];
    const keep = (u: (() => void) | null) => { if (disposed) u?.(); else if (u) unlisten.push(u); };
    void listenSessionConnected(markConnected).then(keep);
    void listenSessionEnded(markEnded).then(keep);
    return () => { disposed = true; unlisten.forEach(u => u()); };
  }, []);

  // One tab per console asked for on the command line (T-020). All but the
  // tab that is shown start their session now: a session used to start only
  // when its tab's view appeared, so after GNS3's "open all consoles" only
  // the last console connected.
  const openCliTabs = (requests: OpenRequest[]) => {
    if (requests.length === 0) return;
    const stamp = Date.now();
    const newTabs = requests.map((r, i) =>
      tabForOpenRequest(r, `tab-${stamp}-${i}-${Math.random().toString(36).slice(2, 6)}`));
    // The backend has normally started each session already (sessionId):
    // the tab only attaches. One it couldn't start is started here -- the
    // shown tab in its own view, the others in the background. A start that
    // fails shows at once; one that connects turns ready (markConnected).
    const shown = newTabs[newTabs.length - 1];
    newTabs.filter((t, i) => !requests[i].sessionId && t !== shown).forEach(t => {
      void startSessionInBackground(t).then(started => {
        if (started) return;
        setTabs(prev => prev.map(x => (x.id === t.id && x.status === 'connecting' ? { ...x, status: 'disconnected' } : x)));
      });
    });
    setTabs(prev => [...prev, ...newTabs]);
    // A session the backend started may have connected, or been refused,
    // before its tab existed: the event found nothing to mark.
    newTabs.filter((_, i) => requests[i].sessionId).forEach(t => {
      void isSessionConnected(t.id).then(connected => { if (connected) markConnected(t.id); });
      void isSessionEnded(t.id).then(ended => { if (ended) markEnded(t.id); });
    });
    setActiveTabId(newTabs[newTabs.length - 1].id);
    setActiveView('sessions');
  };

  useEffect(() => {
    if (!startupDone) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const drain = () => { void takeOpenRequests().then(reqs => { if (!disposed) openCliTabs(reqs); }); };
    // The first console opens at once; the rest of a burst ("open all
    // consoles": twenty launches) in a few batches, not twenty updates.
    const nudge = throttle(drain, 60);
    void listenOpenRequests(nudge).then(u => {
      if (disposed) { u?.(); return; }
      unlisten = u;
      // Anything queued before this page listened: the first launch's own
      // console, and launches that arrived while it was loading.
      drain();
    });
    return () => { disposed = true; unlisten?.(); nudge.cancel(); };
  }, [startupDone]);

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
    recordRecentSession(session.name);
    setRecentNames(getRecentSessions());

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

  const handleOpenLocalShell = () => {
    const open = tabs.filter(t => t.sessionName === 'Local Shell').length;
    const newTab: TerminalTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      title: open > 0 ? `Local Shell (${open + 1})` : 'Local Shell',
      sessionName: 'Local Shell',
      syncChannel: 'none',
      status: 'connecting',
      freeTypeMode: false,
      activeHighlighting: true,
      hostname: '',
      port: 0,
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
  const [broadcastOpen, setBroadcastOpenState] = useState(() => {
    try { return localStorage.getItem('plinky_broadcast_bar') === '1'; } catch { return false; }
  });
  const setBroadcastOpen = (open: boolean) => {
    setBroadcastOpenState(open);
    try { localStorage.setItem('plinky_broadcast_bar', open ? '1' : '0'); } catch { /* not remembered */ }
  };
  const broadcastOpenRef = useRef(broadcastOpen);
  broadcastOpenRef.current = broadcastOpen;
  // Tab shortcuts (shortcuts.ts), read through a ref so the one window
  // listener below always sees the current tabs.
  const onAppShortcutRef = useRef<(action: AppShortcut) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        e.stopPropagation();
        setBroadcastOpen(!broadcastOpenRef.current);
        return;
      }
      const action = appShortcut(e);
      // Not behind an open dialog: Ctrl+Tab there would switch the tab
      // underneath it.
      if (!action || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      onAppShortcutRef.current(action);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // "View host keys" after a changed-key warning opens the list at that host.
  const [hostKeyFilter, setHostKeyFilter] = useState('');
  useEffect(() => {
    const on = (e: Event) => {
      setHostKeyFilter((e as CustomEvent<{ host?: string }>).detail?.host ?? '');
      setActiveView('keys');
    };
    window.addEventListener(SHOW_HOST_KEYS_EVENT, on);
    return () => window.removeEventListener(SHOW_HOST_KEYS_EVENT, on);
  }, []);

  const handleSetActiveView = (view: typeof activeView) => {
    if (view === 'keys') setHostKeyFilter('');
    if (view === 'sftp') setSftpPinned(null);
    setActiveView(view);
  };

  const handleCloseTab = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
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

  const plusButtonRef = useRef<HTMLButtonElement>(null);
  onAppShortcutRef.current = (action) => {
    if (action === 'newTab') {
      const r = plusButtonRef.current?.getBoundingClientRect();
      setLauncherAnchor(r ? { top: r.bottom + 4, left: r.left } : { top: 48, left: 16 });
      return;
    }
    if (tabs.length === 0) return;
    const i = Math.max(0, tabs.findIndex(t => t.id === activeTabId));
    if (action === 'nextTab') setActiveTabId(tabs[(i + 1) % tabs.length].id);
    else if (action === 'prevTab') setActiveTabId(tabs[(i - 1 + tabs.length) % tabs.length].id);
    else void closeTabAsking(tabs[i]);
  };

  /** Ctrl+Shift+W: a key is easy to press by mistake, so a tab that is
   *  still connected asks before its session ends. */
  const closeTabAsking = async (tab: TerminalTab) => {
    if (tab.status !== 'disconnected' && !(await askConfirm({
      title: `Close ${tab.title}?`,
      body: 'Its connection ends.',
      confirmLabel: 'Close tab',
      danger: true,
    }))) return;
    handleCloseTab(tab.id);
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
      // Fill the second pane with a copy of the first. This used to open a
      // made-up session "<name> (Split)" forced to SSH, so splitting a
      // Telnet, serial or Local Shell tab opened a broken SSH connection.
      handleDuplicateTab(activeTab);
    }
  };

  const handleExecuteSnippet = (command: string) => {
    if (!activeTabId) return;
    writeTerminalInput(activeTabId, new TextEncoder().encode(command));
    // The click left the keyboard on the snippet chip (or the parameters
    // dialog), so a snippet sent without a newline, or one that asks
    // "[y/N]", needed a click back into the terminal before Enter worked.
    terminalManager.focusTerminal(activeTabId);
  };

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  const getChannelColor = (ch: SyncChannel) => {
    switch (ch) {
      case 'A': return 'text-ch-a bg-ch-a/10 border-ch-a/30';
      case 'B': return 'text-ch-b bg-ch-b/10 border-ch-b/30';
      case 'C': return 'text-ch-c bg-ch-c/10 border-ch-c/30';
      case 'D': return 'text-ch-d bg-ch-d/10 border-ch-d/30';
      default: return 'text-plinky-muted';
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
          <Terminal className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-sky-400' : 'text-plinky-muted'}`} />
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
        <div className="relative flex-shrink-0 flex flex-col h-full" style={{ width: sidebarWidth }}>
          <SessionExplorer
            sessions={sessions}
            tabs={tabs}
            activeTabId={activeTabId}
            onConnectSession={handleConnectSession}
            onOpenSftp={handleOpenSftp}
            onCreateSession={(folder) => { setNewSessionFolder(folder); setIsNewSessionOpen(true); }}
            onEditSession={handleEditSession}
            onMoveToFolder={handleMoveSessionToFolder}
            onFoldersChanged={reloadSessions}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize session list"
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            tabIndex={0}
            onPointerDown={startSidebarResize}
            onDoubleClick={() => { setSidebarWidth(256); try { localStorage.removeItem('plinky_sidebar_width'); } catch { /* ignore */ } }}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
              if (!step) return;
              e.preventDefault();
              const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarWidth + step));
              setSidebarWidth(next);
              try { localStorage.setItem('plinky_sidebar_width', String(next)); } catch { /* not remembered */ }
            }}
            className="absolute top-0 -right-1 w-2 h-full cursor-col-resize z-10 group/resize focus:outline-none"
          >
            <div className="mx-auto h-full w-px bg-transparent group-hover/resize:bg-sky-500/60 group-focus/resize:bg-sky-500/60 transition-colors" />
          </div>
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
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                        }}
                        data-broadcast-glow={broadcastLit.has(tab.id) ? 'on' : 'off'}
                        // Read by the end-to-end suite (e2e/): the status
                        // icon alone does not name the state.
                        data-tab-status={tab.status}
                        data-tab-active={isActive}
                        style={broadcastLit.has(tab.id) ? { boxShadow: `0 0 0 1px ${glowColor(tab.syncChannel)}, 0 0 10px ${glowColor(tab.syncChannel)}` } : undefined}
                        className={`group relative flex items-center space-x-2 px-3 py-1 text-xs rounded-t border-t border-l border-r cursor-pointer transition max-w-[220px] ${
                          isActive
                            ? 'bg-plinky-950 border-plinky-800 text-sky-300 font-medium shadow-xs'
                            : 'bg-plinky-900/60 border-transparent text-slate-400 hover:text-slate-200 hover:bg-plinky-850'
                        }`}
                      >
                        {renderTabStatusIcon(tab, isActive)}
                        <TabTitle
                          title={tab.title}
                          editing={renamingTabId === tab.id}
                          onStartEdit={() => setRenamingTabId(tab.id)}
                          onCommit={(title) => { handleUpdateTab(tab.id, { title }); setRenamingTabId(null); }}
                          onCancel={() => setRenamingTabId(null)}
                        />

                        {/* Channel Badge Indicator */}
                        {tab.syncChannel !== 'none' && (
                          <span className={`px-1 py-px rounded border text-meta font-bold tabular-nums ${getChannelColor(tab.syncChannel)}`}>
                            {tab.syncChannel}
                          </span>
                        )}

                        <button
                          onClick={(e) => handleCloseTab(tab.id, e)}
                          title="Close Tab"
                          className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded hover:bg-plinky-800 text-plinky-muted hover:text-slate-200 transition"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}

                  {/* "+": open a tab from a menu. It used to open the first
                      saved session in the list, whichever that was. */}
                  <button
                    ref={plusButtonRef}
                    onClick={(e) => {
                      if (launcherAnchor) { setLauncherAnchor(null); return; }
                      const r = e.currentTarget.getBoundingClientRect();
                      setLauncherAnchor({ top: r.bottom + 4, left: r.left });
                    }}
                    title="Open a tab: local shell, recent or saved session, or a new one (Ctrl+Shift+T)"
                    aria-label="Open a tab"
                    aria-expanded={!!launcherAnchor}
                    className="p-1 rounded text-plinky-muted hover:text-slate-300 hover:bg-plinky-800 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  {launcherAnchor && (
                    <TabLauncher
                      anchor={launcherAnchor}
                      sessions={sessions}
                      recentNames={recentNames}
                      onOpenSession={(s) => handleConnectSession(s, true)}
                      onOpenLocalShell={handleOpenLocalShell}
                      onNewSession={() => setIsNewSessionOpen(true)}
                      onClose={() => setLauncherAnchor(null)}
                    />
                  )}
                  {tabMenu && (() => {
                    const menuTab = tabs.find(t => t.id === tabMenu.tabId);
                    if (!menuTab) return null;
                    const item = 'w-full text-left px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 transition';
                    return (
                      <div className="fixed inset-0 z-40" onMouseDown={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }}>
                        <div
                          role="menu"
                          aria-label={`Tab ${menuTab.title}`}
                          style={{ top: tabMenu.y, left: Math.min(tabMenu.x, window.innerWidth - 170) }}
                          className="fixed w-40 bg-plinky-900 border border-plinky-700 rounded-lg shadow-2xl py-1 text-xs text-slate-300"
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <button role="menuitem" className={item} onClick={() => { setTabMenu(null); setRenamingTabId(menuTab.id); }}>Rename</button>
                          <button role="menuitem" className={item} onClick={() => { setTabMenu(null); handleDuplicateTab(menuTab); }}>Duplicate</button>
                          <div className="border-t border-plinky-800 my-1" />
                          <button role="menuitem" className={item} onClick={() => { setTabMenu(null); handleCloseTab(menuTab.id); }}>Close</button>
                        </div>
                      </div>
                    );
                  })()}
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
                    // It used to fill the grid with `while (tabs.length < 4)`,
                    // but `tabs` never changes inside this handler: with
                    // fewer than four tabs open it looped forever and froze
                    // the window. It also connected to whichever saved
                    // sessions came first, unasked. Empty cells now offer
                    // the tab launcher instead.
                    onClick={() => setLayoutMode('grid-4')}
                    title="4-Terminal Cluster Grid (2x2)"
                    className={`p-1.5 rounded transition ${layoutMode === 'grid-4' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40' : 'hover:bg-plinky-800 hover:text-slate-200'}`}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setLayoutMode(layoutMode === 'terminal-sftp' ? 'single' : 'terminal-sftp')}
                    title="Terminal + SFTP Side-by-Side Split"
                    className={`p-1.5 rounded transition ${layoutMode === 'terminal-sftp' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40' : 'hover:bg-plinky-800 hover:text-slate-200'}`}
                  >
                    <FolderGit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Terminal Viewport (Single, Split, Grid, or Terminal+SFTP) */}
              <div className="flex-1 relative overflow-hidden bg-plinky-950 flex flex-col">
                {tabs.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-plinky-muted text-xs space-y-2">
                    <Terminal className="w-8 h-8 text-slate-600" />
                    <span className="text-slate-400">No open terminals</span>
                    {/* This connected to sessions[0], whichever session loaded
                        first ("Connect to access-sw-11"): a one-click way to
                        open the wrong device. It now points at the list. */}
                    {sessions.length > 0 ? (
                      <>
                        <span>Pick a session on the left, or press Ctrl+Shift+O to search.</span>
                        <button
                          onClick={() => window.dispatchEvent(new Event('plinky:focus-session-search'))}
                          className="px-3 py-1.5 rounded bg-sky-700 hover:brightness-110 text-on-accent font-medium transition-colors"
                        >
                          Open a session
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => { setNewSessionFolder(undefined); setIsNewSessionOpen(true); }}
                        className="px-3 py-1.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 font-medium transition-colors"
                      >
                        New session
                      </button>
                    )}
                  </div>
                ) : layoutMode === 'single' ? (
                  <div className="flex-1 relative w-full h-full overflow-hidden">
                    <TerminalView
                      key={activeTab.id}
                      tab={activeTab}
                      onHoverFocus={() => setActiveTabId(activeTab.id)}
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
                        onHoverFocus={() => setActiveTabId(activeTab.id)}
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
                        onHoverFocus={() => setActiveTabId(splitTabs[0].id)}
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
                          onHoverFocus={() => setActiveTabId(splitTabs[1].id)}
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
                      <div className="flex-1 h-full flex flex-col items-center justify-center bg-plinky-950 text-plinky-muted text-xs space-y-2">
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
                        onHoverFocus={() => setActiveTabId(splitTabs[0].id)}
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
                          onHoverFocus={() => setActiveTabId(splitTabs[1].id)}
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
                      <div className="flex-1 w-full flex flex-col items-center justify-center bg-plinky-950 text-plinky-muted text-xs space-y-2">
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
                          onHoverFocus={() => setActiveTabId(tab.id)}
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
                    {Array.from({ length: Math.max(0, 4 - paneTabs(4).length) }, (_, i) => (
                      <div
                        key={`empty-${i}`}
                        className="w-full h-full flex flex-col items-center justify-center bg-plinky-950 text-plinky-muted text-xs space-y-2"
                      >
                        <LayoutGrid className="w-6 h-6 text-slate-600" />
                        <span>Empty pane</span>
                        <button
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setLauncherAnchor({ top: r.bottom + 4, left: r.left });
                          }}
                          className="px-2.5 py-1 rounded bg-plinky-850 hover:bg-plinky-800 text-slate-300 border border-plinky-700"
                        >
                          + Open a tab
                        </button>
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
              <p className="text-xs text-plinky-muted">Connect to a session, or use a saved session's SFTP button in the sidebar.</p>
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
            <HostKeyManager onClose={() => setActiveView('sessions')} initialFilter={hostKeyFilter} />
          )}

          {activeView === 'vault' && (
            <VaultManager onClose={() => setActiveView('sessions')} />
          )}
        </div>
      </div>

      {/* Broadcast bar: on the terminal view only, and only when a tab has a
          channel or it was opened (Ctrl+Shift+B, status bar). It used to take
          a permanent row, on the Vault and Host Keys screens too. */}
      {activeView === 'sessions' && (broadcastOpen || tabs.some(t => t.syncChannel !== 'none')) && (
        <SyncBroadcastBar tabs={tabs} />
      )}

      <ConfirmHost />
      <PasteConfirmHost />
      <TooltipHost />

      {/* Application Bottom Status Bar */}
      <StatusBar
        tabs={tabs}
        activeTabId={activeTabId}
        broadcastOpen={broadcastOpen || tabs.some(t => t.syncChannel !== 'none')}
        onToggleBroadcast={() => setBroadcastOpen(!broadcastOpen)}
      />

      {/* New Session Modal */}
      <NewSessionModal
        isOpen={isNewSessionOpen}
        editingSession={editingSession}
        savedSessions={sessions}
        initialFolder={newSessionFolder}
        onClose={() => {
          setIsNewSessionOpen(false);
          setEditingSession(null);
          setNewSessionFolder(undefined);
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
