import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { TerminalTab, SyncChannel } from '../../types/session';
import { terminalManager } from '../../services/terminalManager';
import { 
  startTerminalSession, 
  attachTerminalSession,
  writeTerminalInput, 
  resizeTerminal, 
  closeTerminalSession,
  answerHostKeyPrompt,
  listenHostKeyPrompts,
  setSyncChannel,
  HostKeyPromptInfo,
  injectShellIntegration,
  isTauriEnvironment
} from '../../services/tauriBridge';
import {
  Radio,
  Sparkles,
  ShieldAlert, 
  Search, 
  ChevronUp, 
  ChevronDown, 
  X, 
  Copy, 
  Clipboard, 
  Trash2, 
  CheckSquare,
  Columns,
  Rows,
  Zap,
  FileText,
  List,
  RotateCcw,
  Download,
  CopyCheck,
  Settings as SettingsIcon,
  Upload
} from 'lucide-react';

interface PuTTYEventLog {
  id: string;
  time: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
}

interface TerminalViewProps {
  tab: TerminalTab;
  onUpdateTab: (tabId: string, updates: Partial<TerminalTab>) => void;
  onSplitPane?: (direction: 'vertical' | 'horizontal') => void;
  onCwdChange?: (cwd: string) => void;
  onDuplicateTab?: (tab: TerminalTab) => void;
  onOpenSettings?: () => void;
  fontFamily?: string;
  fontSize?: number;
  cursorStyle?: 'block' | 'bar' | 'underline';
  copyOnSelect?: boolean;
  rightClickAction?: 'paste' | 'contextMenu';
}

export const TerminalView: React.FC<TerminalViewProps> = ({ 
  tab, 
  onUpdateTab,
  onSplitPane,
  onCwdChange,
  onDuplicateTab,
  onOpenSettings,
  fontFamily,
  fontSize,
  cursorStyle,
  copyOnSelect = true,
  rightClickAction = 'contextMenu',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const isLivePtyRef = useRef<boolean>(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isOsc133IntegratedRef = useRef<boolean>(false);
  const isPromptInputRegionRef = useRef<boolean>(true);
  const promptLinesRef = useRef<number[]>([]);

  const [hooksInjected, setHooksInjected] = useState(false);
  const [hooksError, setHooksError] = useState<string | null>(null);
  // Only consider local if it's explicitly "Local Shell" or flagged as local.
  // PuTTY sessions or SSH targets (even localhost:22) must connect via plink.
  const isLocalSession = tab.sessionName === 'Local Shell' || (tab as any).isLocal === true;
  // Free Type mode's toggle was removed (confusing, no visible feedback) --
  // isFreeType is kept read-only at whatever the tab was created with
  // (always false now, see App.tsx) since the cursor-style/click-to-edit
  // logic below still reads it.
  const [isFreeType] = useState(tab.freeTypeMode);
  const [clickIndicator, setClickIndicator] = useState<{ x: number; y: number } | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<HostKeyPromptInfo | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Search State
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [searchStats, setSearchStats] = useState<{ index: number; total: number } | null>(null);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // PuTTY Event Log State
  const [eventLogs, setEventLogs] = useState<PuTTYEventLog[]>([
    {
      id: 'init-1',
      time: new Date().toTimeString().split(' ')[0],
      message: `Configured session "${tab.sessionName}" target: ${tab.hostname || 'localhost'}:${tab.port || 22}`,
      level: 'info',
    },
  ]);
  const [isEventLogOpen, setIsEventLogOpen] = useState(false);

  // PuTTY Session Logging State
  const [isLogging, setIsLogging] = useState(false);
  const [loggingMode, setLoggingMode] = useState<'printable' | 'all'>('all');
  const [loggedBytes, setLoggedBytes] = useState(0);
  const [isLoggingOpen, setIsLoggingOpen] = useState(false);
  const isLoggingRef = useRef(false);
  const loggingModeRef = useRef<'printable' | 'all'>('all');
  const loggedBufferRef = useRef<string[]>([]);

  const copyOnSelectRef = useRef(copyOnSelect);
  copyOnSelectRef.current = copyOnSelect;

  const addEventLog = useCallback((message: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
    const time = new Date().toTimeString().split(' ')[0];
    setEventLogs(prev => [...prev.slice(-200), { id: `${Date.now()}-${Math.random()}`, time, message, level }]);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm.js instance with modern dark theme
    const defaultFontStack = '"MesloLGS Nerd Font", "MesloLGS NF", "FantasqueSansM Nerd Font", "JetBrainsMono Nerd Font", "JetBrains Mono", "FiraCode Nerd Font", "Fira Code", "DejaVu Sans Mono", monospace';
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: cursorStyle || (isFreeType ? 'bar' : 'block'),
      fontFamily: fontFamily || defaultFontStack,
      fontSize: fontSize || 13,
      lineHeight: 1.25,
      allowTransparency: true,
      theme: {
        background: '#090d16',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        cursorAccent: '#090d16',
        selectionBackground: 'rgba(56, 189, 248, 0.35)',
        black: '#0f172a',
        red: '#f43f5e',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#38bdf8',
        magenta: '#c084fc',
        cyan: '#06b6d4',
        white: '#f8fafc',
        brightBlack: '#475569',
        brightRed: '#fb7185',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#e879f9',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Initialize Search Addon
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

    // Register OSC 133 Shell Integration Handler (Semantic Prompt Gating & Prompt Jumping)
    const osc133Disposable = term.parser.registerOscHandler(133, (data) => {
      isOsc133IntegratedRef.current = true;
      const code = data.charAt(0).toUpperCase();
      if (code === 'B') {
        isPromptInputRegionRef.current = true;
      } else if (code === 'C' || code === 'D') {
        isPromptInputRegionRef.current = false;
      } else if (code === 'A') {
        const line = term.buffer.active.cursorY + term.buffer.active.baseY;
        if (!promptLinesRef.current.includes(line)) {
          promptLinesRef.current.push(line);
          if (promptLinesRef.current.length > 500) promptLinesRef.current.shift();
        }
      }
      return false;
    });

    // Register OSC 7 Handler (Current Working Directory Reporting for SFTP Directory Following)
    const osc7Disposable = term.parser.registerOscHandler(7, (data) => {
      try {
        const filePrefix = 'file://';
        let path = '';
        if (data.startsWith(filePrefix)) {
          const rest = data.slice(filePrefix.length);
          const slashIdx = rest.indexOf('/');
          if (slashIdx !== -1) {
            path = rest.slice(slashIdx);
          }
        } else if (data.startsWith('/')) {
          path = data;
        }
        if (path) {
          onCwdChange?.(path);
        }
      } catch (e) {
        console.warn('Failed to parse OSC 7 directory:', e);
      }
      return false;
    });

    searchAddon.onDidChangeResults((e) => {
      if (e) {
        setSearchStats({ index: e.resultIndex, total: e.resultCount });
      } else {
        setSearchStats(null);
      }
    });

    term.open(containerRef.current);
    fitAddon.fit();
    // A freshly connected session needs keyboard focus immediately -- the
    // user is about to be looking at a host-key or password prompt and
    // should be able to just start typing, not have to click into the
    // terminal first.
    term.focus();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Register terminal with manager for broadcast sync input
    terminalManager.registerTerminal(tab.id, term, tab.syncChannel);
    terminalManager.setActiveTab(tab.id);

    // Register Real-time Regex Link Provider (IPs, URLs)
    term.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: Array<{
          range: { start: { x: number; y: number }; end: { x: number; y: number } };
          text: string;
          activate: (event: MouseEvent, text: string) => void;
        }> = [];

        // IPv4 Pattern Matcher
        const ipRegex = /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
        let match;
        while ((match = ipRegex.exec(text)) !== null) {
          const start = match.index + 1;
          const matchedText = match[0];
          links.push({
            range: {
              start: { x: start, y: bufferLineNumber },
              end: { x: start + matchedText.length, y: bufferLineNumber },
            },
            text: matchedText,
            activate: (_e, ip) => {
              if (navigator.clipboard) {
                navigator.clipboard.writeText(ip);
              }
            },
          });
        }

        // URL Pattern Matcher
        const urlRegex = /https?:\/\/[^\s/$.?#].[^\s]*/g;
        while ((match = urlRegex.exec(text)) !== null) {
          const start = match.index + 1;
          const matchedText = match[0];
          links.push({
            range: {
              start: { x: start, y: bufferLineNumber },
              end: { x: start + matchedText.length, y: bufferLineNumber },
            },
            text: matchedText,
            activate: (_e, url) => {
              window.open(url, '_blank');
            },
          });
        }

        callback(links);
      },
    });

    // Subscribe to native host key prompt events from backend
    let unlistenPrompts: (() => void) | null = null;
    listenHostKeyPrompts((event) => {
      if (event.session_id === tab.id) {
        setPendingPrompt(event.prompt);
        onUpdateTab(tab.id, { status: 'preauth' });
      }
    }).then((unlisten) => {
      unlistenPrompts = unlisten;
    });

    const handleIncomingChunk = (chunk: Uint8Array) => {
      isLivePtyRef.current = true;
      term.write(chunk);
      const text = new TextDecoder().decode(chunk);

      // Status transitions
      const isPreauthPattern = (
        text.includes('password:') || 
        text.includes('Password:') || 
        text.includes('login as:') || 
        text.includes('Using username') ||
        text.includes('passphrase') ||
        text.includes('Passphrase') ||
        text.includes('(yes/no') ||
        text.includes('Store key in cache?')
      );
      const isLivePattern = (
        text.includes('Access granted') || 
        text.includes('Last login:') || 
        /(?:[\$#%❯]\s*)$/m.test(text.trim())
      );

      if (text.includes('[Plinky: Session closed') || text.includes('FATAL ERROR:')) {
        onUpdateTab(tab.id, { status: 'disconnected' });
      } else if (isPreauthPattern) {
        onUpdateTab(tab.id, { status: 'preauth' });
      } else if (isLivePattern) {
        onUpdateTab(tab.id, { status: 'live' });
      }

      if (isLoggingRef.current) {
        if (loggingModeRef.current === 'printable') {
          const printable = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
          loggedBufferRef.current.push(printable);
          setLoggedBytes(prev => prev + printable.length);
        } else {
          loggedBufferRef.current.push(text);
          setLoggedBytes(prev => prev + chunk.byteLength);
        }
      }
    };

    // PuTTY Classic: Copy on select
    term.onSelectionChange(() => {
      if (copyOnSelectRef.current) {
        const selection = term.getSelection();
        if (selection && selection.length > 0 && navigator.clipboard) {
          navigator.clipboard.writeText(selection);
        }
      }
    });

    // Attempt to reattach to existing session or start a new PTY session
    attachTerminalSession(tab.id, 0, handleIncomingChunk).then((attachInfo) => {
      if (attachInfo && attachInfo.replay_data.length > 0) {
        handleIncomingChunk(new Uint8Array(attachInfo.replay_data));
        addEventLog(`Attached to active session "${tab.sessionName}" with replayed scrollback`, 'success');
        onUpdateTab(tab.id, { status: 'live' });
      } else {
        // Fresh start
        addEventLog(`Spawning session "${tab.sessionName}" (${tab.hostname || 'local'}:${tab.port || 22})`, 'info');
        startTerminalSession(
          tab.id,
          tab.sessionName,
          isLocalSession,
          term.cols,
          term.rows,
          handleIncomingChunk,
          tab.hostname,
          tab.port,
          tab.username,
          (tab as any).logFileName
        ).then((started) => {
          if (!started) {
            onUpdateTab(tab.id, { status: 'disconnected' });
            if (isTauriEnvironment()) {
              term.writeln(`\r\n\x1b[31m[Plinky Error: Failed to start session "${tab.sessionName}". Verify that PuTTY (plink) is installed and target host is reachable.]\x1b[0m\r\n`);
              addEventLog(`Failed to start PTY session "${tab.sessionName}"`, 'error');
            } else {
              // Browser development preview fallback banner (non-Tauri mode)
              term.writeln(`\x1b[33m[Plinky: Running in Web Browser Dev Mode - Desktop Tauri Backend Inactive]\x1b[0m\r\n`);
              addEventLog("Running in browser development preview mode", 'info');
              onUpdateTab(tab.id, { status: 'live' });
            }
          } else {
            addEventLog(`PTY session live. Terminal ready.`, 'success');
          }
        });
      }
    });

    // Handle user keyboard input
    term.onData((data) => {
      if (isLivePtyRef.current) {
        writeTerminalInput(tab.id, new TextEncoder().encode(data));
      } else if (!isTauriEnvironment()) {
        // Echo input locally for browser preview
        if (data === '\r') {
          term.write('\r\n');
        } else if (data === '\u007F') {
          term.write('\b \b');
        } else {
          term.write(data);
        }
      }
    });

    term.onResize(({ cols, rows }) => {
      if (isLivePtyRef.current) {
        resizeTerminal(tab.id, cols, rows);
      }
    });

    // Handle Ctrl+F for search and Ctrl+Up/Down for prompt navigation
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      } else if (e.key === 'Escape' && isSearchOpen) {
        setIsSearchOpen(false);
        searchAddonRef.current?.clearDecorations();
        term.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp') {
        // OSC 133 semantic prompt jump previous
        e.preventDefault();
        const currentScrollY = term.buffer.active.viewportY;
        const sorted = [...promptLinesRef.current].sort((a, b) => a - b);
        const prev = sorted.reverse().find(l => l < currentScrollY);
        if (prev !== undefined) {
          term.scrollToLine(prev);
        } else if (sorted.length > 0) {
          term.scrollToLine(sorted[0]);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown') {
        // OSC 133 semantic prompt jump next
        e.preventDefault();
        const currentScrollY = term.buffer.active.viewportY;
        const sorted = [...promptLinesRef.current].sort((a, b) => a - b);
        const next = sorted.find(l => l > currentScrollY);
        if (next !== undefined) {
          term.scrollToLine(next);
        } else {
          term.scrollToBottom();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    const handleResize = () => {
      try {
        fitAddon.fit();
        if (isLivePtyRef.current && term.cols && term.rows) {
          resizeTerminal(tab.id, term.cols, term.rows);
        }
      } catch {
        // Ignored
      }
    };

    window.addEventListener('resize', handleResize);

    // Dynamic container resize observer (handles split view toggles, sidebar collapse, sftp pane)
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(handleResize);
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (unlistenPrompts) {
        unlistenPrompts();
      }
      setSyncChannel(tab.id, null);
      terminalManager.unregisterTerminal(tab.id);
      osc133Disposable.dispose();
      osc7Disposable.dispose();
      if (isLivePtyRef.current) {
        closeTerminalSession(tab.id);
      }
      term.dispose();
    };
  }, [tab.id, tab.sessionName, tab.hostname, tab.port, tab.username]);

  // Execute in-buffer search
  const performSearch = useCallback((direction: 'next' | 'prev' = 'next') => {
    if (!searchAddonRef.current || !searchQuery) return;
    const options = {
      caseSensitive,
      wholeWord,
      regex: isRegex,
      incremental: direction === 'next',
      decorations: {
        matchOverviewRuler: '#38bdf8',
        activeMatchColorOverviewRuler: '#f59e0b',
        matchBackground: 'rgba(56, 189, 248, 0.3)',
        activeMatchBackground: 'rgba(245, 158, 11, 0.6)',
      }
    };

    if (direction === 'next') {
      searchAddonRef.current.findNext(searchQuery, options);
    } else {
      searchAddonRef.current.findPrevious(searchQuery, options);
    }
  }, [searchQuery, caseSensitive, wholeWord, isRegex]);

  useEffect(() => {
    if (isSearchOpen && searchQuery) {
      performSearch('next');
    } else if (!searchQuery && searchAddonRef.current) {
      searchAddonRef.current.clearDecorations();
      setSearchStats(null);
    }
  }, [searchQuery, caseSensitive, wholeWord, isRegex, isSearchOpen, performSearch]);

  // Dynamically update font family, font size, or cursor style from settings
  useEffect(() => {
    if (terminalRef.current) {
      if (fontFamily) {
        terminalRef.current.options.fontFamily = fontFamily;
      }
      if (fontSize) {
        terminalRef.current.options.fontSize = fontSize;
      }
      if (cursorStyle) {
        terminalRef.current.options.cursorStyle = cursorStyle;
      }
      fitAddonRef.current?.fit();
    }
  }, [fontFamily, fontSize, cursorStyle]);

  // WindTerm Free Type Mode: Arbitrary cursor placement and delta computation
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Close context menu on left click
    if (contextMenu) {
      setContextMenu(null);
    }

    if (!isFreeType || !containerRef.current || !terminalRef.current) return;
    const term = terminalRef.current;

    // Gating 1: Suppress in alternate screen buffer (vim, nano, htop, less)
    if (term.buffer.active.type === 'alternate') {
      return;
    }

    // Gating 2: Suppress if OSC 133 semantic prompt is integrated and outside B..C input region
    if (isOsc133IntegratedRef.current && !isPromptInputRegionRef.current) {
      return;
    }

    const screenEl = containerRef.current.querySelector('.xterm-screen');
    if (!screenEl) return;

    const rect = screenEl.getBoundingClientRect();
    const cellWidth = rect.width / term.cols;
    const cellHeight = rect.height / term.rows;

    const targetCol = Math.floor((e.clientX - rect.left) / cellWidth);
    const targetRow = Math.floor((e.clientY - rect.top) / cellHeight);

    // Visual click ripple
    const localX = e.clientX - containerRef.current.getBoundingClientRect().left;
    const localY = e.clientY - containerRef.current.getBoundingClientRect().top;
    setClickIndicator({ x: localX, y: localY });
    setTimeout(() => setClickIndicator(null), 600);

    const cursorCol = term.buffer.active.cursorX;
    const cursorRow = term.buffer.active.cursorY;

    // Line gating: only move cursor if clicking on the active input row
    if (targetRow === cursorRow && targetCol >= 0 && targetCol < term.cols) {
      // Gating 3: DECCKM (Application Cursor Keys Mode)
      // When DECCKM is active, arrow keys send SS3 (\x1bO[A-D]) instead of CSI (\x1b[[A-D])
      const isDecckm = (term.modes as { applicationCursorKeysMode?: boolean } | undefined)?.applicationCursorKeysMode === true;
      const rightSeqToken = isDecckm ? '\x1bOC' : '\x1b[C';
      const leftSeqToken = isDecckm ? '\x1bOD' : '\x1b[D';

      const delta = targetCol - cursorCol;
      if (delta > 0) {
        const rightSeq = rightSeqToken.repeat(delta);
        if (isLivePtyRef.current) {
          writeTerminalInput(tab.id, new TextEncoder().encode(rightSeq));
        } else {
          term.write(rightSeq);
        }
      } else if (delta < 0) {
        const leftSeq = leftSeqToken.repeat(Math.abs(delta));
        if (isLivePtyRef.current) {
          writeTerminalInput(tab.id, new TextEncoder().encode(leftSeq));
        } else {
          term.write(leftSeq);
        }
      }
    }

    term.focus();
  }, [isFreeType, tab.id, contextMenu]);

  // Context Menu Handler
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (rightClickAction === 'paste' && !e.shiftKey) {
      handlePaste();
      return;
    }
    const x = Math.min(e.clientX, window.innerWidth - 240);
    const y = Math.min(e.clientY, window.innerHeight - 380);
    setContextMenu({ x, y });
  };

  const handleCopy = () => {
    const selection = terminalRef.current?.getSelection();
    if (selection && navigator.clipboard) {
      navigator.clipboard.writeText(selection);
    }
    setContextMenu(null);
  };

  const handleCopyAll = () => {
    if (!terminalRef.current) return;
    const buffer = terminalRef.current.buffer.active;
    let fullText = '';
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        fullText += line.translateToString(true) + '\n';
      }
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(fullText.trimEnd());
      addEventLog(`Copied entire scrollback (${buffer.length} lines) to clipboard`, 'info');
    }
    setContextMenu(null);
  };

  const handlePaste = async () => {
    if (navigator.clipboard) {
      const text = await navigator.clipboard.readText();
      if (text) {
        if (isLivePtyRef.current) {
          writeTerminalInput(tab.id, new TextEncoder().encode(text));
        } else {
          terminalRef.current?.write(text);
        }
      }
    }
    setContextMenu(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const paths = files.map(f => {
      const fullPath = (f as any).path || f.name;
      // Always single-quote, unconditionally -- the previous version only
      // quoted when the path contained space/$/&/(, which misses every
      // other shell metacharacter (;, |, `, ", *, newlines, ...). A file
      // or directory with a crafted name could paste as what looks like a
      // harmless path but actually injects a second shell command once the
      // user hits Enter. Single-quoting is the standard, complete fix: wrap
      // in '...' and escape embedded quotes as '\''.
      return `'${fullPath.replace(/'/g, "'\\''")}'`;
    }).join(' ');

    if (isLivePtyRef.current) {
      writeTerminalInput(tab.id, new TextEncoder().encode(paths));
    } else {
      terminalRef.current?.write(paths);
    }
    terminalRef.current?.focus();
    addEventLog(`Pasted dropped file path(s) into terminal: ${paths}`, 'info');
  };

  const handleSelectAll = () => {
    terminalRef.current?.selectAll();
    setContextMenu(null);
  };

  const handleClearScrollback = () => {
    terminalRef.current?.clear();
    addEventLog("Terminal scrollback cleared", 'info');
    setContextMenu(null);
  };

  const handleResetTerminal = () => {
    if (terminalRef.current) {
      terminalRef.current.reset();
    }
    if (isLivePtyRef.current) {
      writeTerminalInput(tab.id, new TextEncoder().encode('\x1bc'));
    }
    addEventLog("Terminal hard reset (RIS) sent", 'info');
    setContextMenu(null);
  };

  const handleExportLog = () => {
    const fullText = loggedBufferRef.current.join('');
    const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plinky_${tab.sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addEventLog(`Exported session log (${(fullText.length / 1024).toFixed(1)} KB)`, 'success');
  };

  const handleAnswerPrompt = async (answer: 'store' | 'once' | 'reject') => {
    await answerHostKeyPrompt(tab.id, answer);
    setPendingPrompt(null);
    terminalRef.current?.focus();
  };

  const cycleChannel = () => {
    const channels: SyncChannel[] = ['none', 'A', 'B', 'C', 'D'];
    const currentIdx = channels.indexOf(tab.syncChannel);
    const nextChannel = channels[(currentIdx + 1) % channels.length];
    onUpdateTab(tab.id, { syncChannel: nextChannel });
    terminalManager.setSyncChannel(tab.id, nextChannel);
    setSyncChannel(tab.id, nextChannel === 'none' ? null : nextChannel);
  };

  const handleInjectHooks = async () => {
    setHooksError(null);
    if (!isLivePtyRef.current) {
      // injectShellIntegration silently returns false on backend rejection
      // (e.g. write_input_live_only refusing a session that's still at a
      // host-key or password prompt) -- that failure needs to be visible,
      // not just a console.warn, or the button looks like it does nothing.
      setHooksError('Session is not connected yet -- log in first, then inject hooks.');
      setTimeout(() => setHooksError(null), 4000);
      return;
    }
    try {
      const ok = await injectShellIntegration(tab.id, 'bash');
      if (ok) {
        setHooksInjected(true);
      } else {
        setHooksError('Failed to inject shell hooks.');
        setTimeout(() => setHooksError(null), 4000);
      }
    } catch (e) {
      console.warn('Failed to inject hooks:', e);
      setHooksError('Failed to inject shell hooks.');
      setTimeout(() => setHooksError(null), 4000);
    }
  };

  const getChannelColor = (ch: SyncChannel) => {
    switch (ch) {
      case 'A': return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40';
      case 'B': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40';
      case 'C': return 'bg-amber-500/20 text-amber-400 border-amber-500/40';
      case 'D': return 'bg-rose-500/20 text-rose-400 border-rose-500/40';
      default: return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  return (
    <div 
      className="relative flex flex-col h-full w-full bg-plinky-950 overflow-hidden"
      onContextMenu={handleContextMenu}
    >
      {/* Tab Control Overlay Header */}
      <div className="relative flex items-center justify-between px-3 py-1.5 bg-plinky-900/90 border-b border-plinky-800 text-xs select-none">
        <div className="flex items-center space-x-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="font-semibold text-slate-200">{tab.sessionName}</span>
          <span className="text-slate-500 font-mono">
            {isLocalSession ? '(local shell)' : `(${tab.hostname}:${tab.port})`}
          </span>
        </div>

        {hooksError && (
          <div className="absolute top-full right-3 mt-1 z-40 px-2 py-1 rounded bg-rose-950/95 border border-rose-500/50 text-rose-300 text-[11px] shadow-lg animate-in fade-in slide-in-from-top-1 duration-150">
            {hooksError}
          </div>
        )}
        <div className="flex items-center space-x-2">
          {/* Shell Integration Hook Injector Button */}
          <button
            onClick={handleInjectHooks}
            title="Inject OSC 133 semantic prompt markers & OSC 7 directory tracking into bash"
            className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-[11px] transition-all ${
              hooksInjected
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                : 'bg-slate-800/80 text-slate-400 border-slate-700 hover:text-slate-300'
            }`}
          >
            <Zap className="w-3 h-3 text-emerald-400" />
            <span>{hooksInjected ? 'Hooks Active' : 'Shell Hooks'}</span>
          </button>

          {/* Find In Terminal Button */}
          <button
            onClick={() => {
              setIsSearchOpen(true);
              setTimeout(() => searchInputRef.current?.focus(), 50);
            }}
            title="Find in Terminal (Ctrl+F)"
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-[11px] transition"
          >
            <Search className="w-3 h-3 text-sky-400" />
            <span>Find</span>
          </button>

          {/* Sync Input Channel Badge */}
          <button
            onClick={cycleChannel}
            title="Click to cycle broadcast sync channel (A, B, C, D, none)"
            className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-[11px] font-mono transition-all ${getChannelColor(tab.syncChannel)}`}
          >
            <Radio className="w-3 h-3" />
            <span>Channel: {tab.syncChannel === 'none' ? 'Off' : tab.syncChannel}</span>
          </button>

          {/* Regex Highlighting Indicator */}
          <span
            title="Active Regex Highlighting: IPs, UUIDs, Errors, Warnings, URLs (Clickable links enabled)"
            className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 text-[11px]"
          >
            <Sparkles className="w-3 h-3" />
            <span>Regex Hi</span>
          </span>

          {/* PuTTY Session Logging Button */}
          <button
            onClick={() => setIsLoggingOpen(true)}
            title="Session Logging (PuTTY-style) - record output to log file"
            className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-[11px] transition-all ${
              isLogging
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/50'
                : 'bg-slate-800/80 text-slate-400 border-slate-700 hover:text-slate-300'
            }`}
          >
            {isLogging ? (
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-ping"></span>
            ) : (
              <FileText className="w-3 h-3 text-amber-400" />
            )}
            <span>{isLogging ? `Log: ${(loggedBytes / 1024).toFixed(1)}k` : 'Log'}</span>
          </button>

          {/* PuTTY Event Log Button */}
          <button
            onClick={() => setIsEventLogOpen(true)}
            title="PuTTY Event Log - view connection diagnostics and trace"
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 border border-slate-700 text-[11px] transition"
          >
            <List className="w-3 h-3 text-cyan-400" />
            <span>Events</span>
          </button>
        </div>
      </div>

      {/* Floating In-Buffer Search Bar Overlay */}
      {isSearchOpen && (
        <div className="absolute top-10 right-4 z-40 flex items-center space-x-1.5 p-2 bg-plinky-900 border border-sky-500/40 rounded-lg shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-150 text-xs">
          <Search className="w-3.5 h-3.5 text-sky-400 ml-1" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Find in terminal..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) {
                  performSearch('prev');
                } else {
                  performSearch('next');
                }
              }
            }}
            className="w-44 bg-plinky-950 border border-plinky-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-hidden focus:border-sky-500"
          />

          {/* Search Result Counter */}
          <span className="text-[10px] font-mono text-slate-400 px-1 min-w-[50px] text-center">
            {searchStats ? `${searchStats.index + 1}/${searchStats.total}` : (searchQuery ? '0/0' : '')}
          </span>

          {/* Direction Navigation */}
          <button
            onClick={() => performSearch('prev')}
            title="Previous Match (Shift+Enter)"
            className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-white"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => performSearch('next')}
            title="Next Match (Enter)"
            className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-white"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>

          {/* Match Options Toggles */}
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            title="Match Case"
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
              caseSensitive ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
          >
            Aa
          </button>
          <button
            onClick={() => setWholeWord(!wholeWord)}
            title="Match Whole Word"
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
              wholeWord ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
          >
            \b
          </button>
          <button
            onClick={() => setIsRegex(!isRegex)}
            title="Use Regular Expression"
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
              isRegex ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
          >
            .*
          </button>

          {/* Close Search */}
          <button
            onClick={() => {
              setIsSearchOpen(false);
              searchAddonRef.current?.clearDecorations();
              terminalRef.current?.focus();
            }}
            title="Close Search (Esc)"
            className="p-1 text-slate-500 hover:text-rose-400 ml-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Terminal Viewport */}
      <div
        ref={containerRef}
        onClick={handleCanvasClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex-1 relative w-full h-full overflow-hidden ${isFreeType ? 'free-type-active' : ''}`}
      >
        {/* Drag and Drop File Path Overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-30 pointer-events-none border-2 border-dashed border-sky-400 bg-sky-950/70 backdrop-blur-xs flex items-center justify-center text-sky-300 font-mono text-xs space-x-2 animate-in fade-in duration-100">
            <Upload className="w-5 h-5 text-sky-400 animate-bounce" />
            <span>Drop file to paste path into terminal</span>
          </div>
        )}
        {/* Free Type Visual Click Indicator */}
        {clickIndicator && (
          <div
            className="free-type-cursor-indicator rounded"
            style={{
              left: clickIndicator.x - 12,
              top: clickIndicator.y - 8,
              width: '24px',
              height: '18px',
            }}
          />
        )}

        {/* Custom Terminal Context Menu */}
        {contextMenu && (
          <div
            className="fixed z-50 w-52 bg-plinky-900 border border-plinky-700/80 rounded-lg shadow-2xl py-1 text-slate-200 text-xs select-none backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={handleCopy}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Copy className="w-3.5 h-3.5 text-sky-400" />
              <span>Copy Selection</span>
            </button>
            <button
              onClick={handleCopyAll}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <CopyCheck className="w-3.5 h-3.5 text-cyan-400" />
              <span>Copy All to Clipboard</span>
            </button>
            <button
              onClick={handlePaste}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Clipboard className="w-3.5 h-3.5 text-emerald-400" />
              <span>Paste Clipboard</span>
            </button>
            <button
              onClick={handleSelectAll}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
              <span>Select All</span>
            </button>
            <div className="border-t border-plinky-800 my-1" />
            <button
              onClick={handleClearScrollback}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Trash2 className="w-3.5 h-3.5 text-amber-400" />
              <span>Clear Scrollback</span>
            </button>
            <button
              onClick={handleResetTerminal}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <RotateCcw className="w-3.5 h-3.5 text-rose-400" />
              <span>Reset Terminal (RIS)</span>
            </button>
            <div className="border-t border-plinky-800 my-1" />
            <button
              onClick={() => {
                setContextMenu(null);
                setIsEventLogOpen(true);
              }}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <List className="w-3.5 h-3.5 text-cyan-400" />
              <span>PuTTY Event Log...</span>
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                setIsLoggingOpen(true);
              }}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <FileText className="w-3.5 h-3.5 text-amber-400" />
              <span>Session Logging...</span>
            </button>
            {onDuplicateTab && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  onDuplicateTab(tab);
                }}
                className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
              >
                <Copy className="w-3.5 h-3.5 text-emerald-400" />
                <span>Duplicate Session</span>
              </button>
            )}
            {onOpenSettings && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  onOpenSettings();
                }}
                className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
              >
                <SettingsIcon className="w-3.5 h-3.5 text-slate-400" />
                <span>Change Settings...</span>
              </button>
            )}
            <div className="border-t border-plinky-800 my-1" />
            <button
              onClick={() => {
                setContextMenu(null);
                setIsSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Search className="w-3.5 h-3.5 text-amber-400" />
              <span>Find in Terminal...</span>
            </button>
            {onSplitPane && (
              <>
                <div className="border-t border-plinky-800 my-1" />
                <button
                  onClick={() => {
                    onSplitPane('vertical');
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
                >
                  <Columns className="w-3.5 h-3.5 text-sky-400" />
                  <span>Split Vertically</span>
                </button>
                <button
                  onClick={() => {
                    onSplitPane('horizontal');
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
                >
                  <Rows className="w-3.5 h-3.5 text-sky-400" />
                  <span>Split Horizontally</span>
                </button>
              </>
            )}
          </div>
        )}

        {/* PuTTY Event Log Modal */}
        {isEventLogOpen && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-plinky-900 border border-cyan-500/60 rounded-xl shadow-2xl max-w-2xl w-full flex flex-col max-h-[80vh] overflow-hidden text-slate-100">
              <div className="px-4 py-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <List className="w-4 h-4 text-cyan-400" />
                  <span className="font-semibold text-sm">PuTTY Event Log — {tab.sessionName}</span>
                </div>
                <button
                  onClick={() => setIsEventLogOpen(false)}
                  className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 bg-slate-950/90 font-mono text-[11px] space-y-1 select-text">
                {eventLogs.length === 0 ? (
                  <div className="text-slate-500 italic">No events logged yet.</div>
                ) : (
                  eventLogs.map((log) => (
                    <div key={log.id} className="flex space-x-2 leading-relaxed">
                      <span className="text-slate-500 select-none">[{log.time}]</span>
                      <span
                        className={
                          log.level === 'error'
                            ? 'text-rose-400'
                            : log.level === 'warn'
                            ? 'text-amber-400'
                            : log.level === 'success'
                            ? 'text-emerald-400 font-medium'
                            : 'text-slate-300'
                        }
                      >
                        {log.message}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="p-3 bg-plinky-950 border-t border-plinky-800 flex items-center justify-between">
                <button
                  onClick={() => {
                    const text = eventLogs.map(e => `[${e.time}] ${e.message}`).join('\n');
                    if (navigator.clipboard) {
                      navigator.clipboard.writeText(text);
                    }
                    addEventLog("Event log copied to clipboard", 'info');
                  }}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
                >
                  <CopyCheck className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Copy All to Clipboard</span>
                </button>

                <div className="flex space-x-2">
                  <button
                    onClick={() => setEventLogs([])}
                    className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs transition"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setIsEventLogOpen(false)}
                    className="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PuTTY Session Logging Modal */}
        {isLoggingOpen && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-plinky-900 border border-amber-500/60 rounded-xl shadow-2xl max-w-md w-full flex flex-col overflow-hidden text-slate-100">
              <div className="px-4 py-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <FileText className="w-4 h-4 text-amber-400" />
                  <span className="font-semibold text-sm">PuTTY Session Logging</span>
                </div>
                <button
                  onClick={() => setIsLoggingOpen(false)}
                  className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-4 space-y-4 text-xs">
                {/* Status Bar */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-plinky-950 border border-plinky-800">
                  <div className="flex items-center space-x-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${isLogging ? 'bg-rose-500 animate-ping' : 'bg-slate-600'}`}></span>
                    <span className="font-semibold text-slate-200">
                      {isLogging ? 'Logging is ACTIVE' : 'Logging is STOPPED'}
                    </span>
                  </div>
                  <span className="font-mono text-slate-400">
                    {(loggedBytes / 1024).toFixed(1)} KB logged
                  </span>
                </div>

                {/* Mode Selector */}
                <div className="space-y-1.5">
                  <label className="text-slate-400 font-medium">Session Logging Mode</label>
                  <div className="space-y-2">
                    <label className="flex items-center space-x-2 cursor-pointer p-2 rounded bg-plinky-950 border border-plinky-800 hover:border-slate-700">
                      <input
                        type="radio"
                        name="loggingMode"
                        checked={loggingMode === 'all'}
                        onChange={() => setLoggingMode('all')}
                        className="text-sky-500 focus:ring-0"
                      />
                      <div>
                        <span className="text-slate-200 font-medium block">All session output</span>
                        <span className="text-[10px] text-slate-500 block">Includes terminal escapes, cursor sequences, and raw VT codes.</span>
                      </div>
                    </label>

                    <label className="flex items-center space-x-2 cursor-pointer p-2 rounded bg-plinky-950 border border-plinky-800 hover:border-slate-700">
                      <input
                        type="radio"
                        name="loggingMode"
                        checked={loggingMode === 'printable'}
                        onChange={() => setLoggingMode('printable')}
                        className="text-sky-500 focus:ring-0"
                      />
                      <div>
                        <span className="text-slate-200 font-medium block">Printable output only</span>
                        <span className="text-[10px] text-slate-500 block">Strips ANSI color and cursor codes, keeping pure printable text.</span>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between pt-2 border-t border-plinky-800">
                  <button
                    onClick={() => {
                      const next = !isLogging;
                      setIsLogging(next);
                      addEventLog(`PuTTY session logging ${next ? 'started' : 'stopped'} (mode: ${loggingMode})`, next ? 'success' : 'info');
                    }}
                    className={`px-3 py-1.5 rounded font-medium transition ${
                      isLogging
                        ? 'bg-rose-600 hover:bg-rose-500 text-white'
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    }`}
                  >
                    {isLogging ? 'Stop Logging' : 'Start Logging'}
                  </button>

                  <div className="flex space-x-2">
                    <button
                      onClick={handleExportLog}
                      disabled={loggedBufferRef.current.length === 0}
                      className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-medium transition"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Export .log</span>
                    </button>

                    <button
                      onClick={() => {
                        loggedBufferRef.current = [];
                        setLoggedBytes(0);
                        addEventLog("Session log buffer cleared", 'info');
                      }}
                      className="px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Native Host Key Verification Dialog */}
        {pendingPrompt && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-plinky-900 border border-amber-500/60 rounded-xl shadow-2xl max-w-lg w-full p-6 text-slate-100">
              <div className="flex items-start space-x-3 mb-4">
                <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                  <ShieldAlert className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">Host Key Verification Required</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    The server's host key is not cached in PuTTY's known hosts store. You have no guarantee that the server is the computer you think it is.
                  </p>
                </div>
              </div>

              <div className="space-y-2 bg-slate-950/80 rounded-lg p-3 border border-slate-800 text-xs font-mono mb-5">
                <div className="flex justify-between">
                  <span className="text-slate-400">Destination:</span>
                  <span className="text-slate-200 font-semibold">{pendingPrompt.host}:{pendingPrompt.port}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Key Type:</span>
                  <span className="text-cyan-400">{pendingPrompt.key_type}</span>
                </div>
                <div>
                  <span className="text-slate-400 block mb-1">Key Fingerprint:</span>
                  <span className="text-emerald-400 break-all select-all font-bold">{pendingPrompt.fingerprint}</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 justify-end">
                <button
                  onClick={() => handleAnswerPrompt('reject')}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-all"
                >
                  Abandon Connection
                </button>
                <button
                  onClick={() => handleAnswerPrompt('once')}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-amber-500/30 text-amber-300 text-xs font-medium transition-all"
                >
                  Connect Just Once
                </button>
                <button
                  onClick={() => handleAnswerPrompt('store')}
                  className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium shadow-sm transition-all"
                >
                  Store Key in Cache & Connect
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
