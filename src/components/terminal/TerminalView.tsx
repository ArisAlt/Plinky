import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { askConfirm } from '../../services/confirm';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { TerminalTab, SyncChannel } from '../../types/session';
import { terminalManager } from '../../services/terminalManager';
import { 
  startTerminalSession, 
  attachTerminalSession,
  startSessionLog,
  stopSessionLog,
  sessionLogStatus,
  detachTerminalSession,
  backgroundStartOf,
  targetProtocolOf,
  createOutputAcker,
  writeTerminalInput, 
  resizeTerminal, 
  closeTerminalSession,
  answerHostKeyPrompt,
  listPuttyHostKeys,
  showHostKeys,
  listenHostKeyPrompts,
  setSyncChannel,
  HostKeyPromptInfo,
  injectShellIntegration,
  isTauriEnvironment,
  isSessionClosed,
  vaultGetEntry,
  vaultIsInitialized,
  vaultLookup,
  vaultSendSecret,
  sendBreak,
  readPuttySession,
  listenSessionConnected,
  isSessionConnected,
  pickScriptFile,
  runScript,
  stopScript,
  listenScriptStarted,
  listenScriptLog,
  listenScriptEnded,
  pastePaced,
  cancelPaste,
  listenPasteProgress,
  reopenSessionId,
  VaultLookup,
  VAULT_CHANGED_EVENT,
} from '../../services/tauriBridge';
import {
  classifyPasswordPrompt, appendRecentOutput, isUsernamePrompt, trackTypedInput, isPrivilegeCommand, TypedInput,
} from '../../services/promptDetect';
import { KeywordHighlighter } from '../../services/keywordHighlight';
import { shouldTakeHoverFocus } from '../../services/hoverFocus';
import { useBroadcastGlow, glowColor } from '../../services/broadcast';
import { SESSION_SAVED_EVENT, SessionSavedDetail, pasteLineDelayFrom, isMultiLinePaste, RECONNECT_DELAYS_S } from '../../services/appEvents';
import { useTerminalTheme } from '../../themes/terminalThemes';
import { STATUS_DOT, STATUS_TEXT } from '../../services/sessionStatus';
import { VaultUnlockDialog } from '../vault/VaultUnlockDialog';
import { fatalHint, sshBannerHint } from '../../services/fatalHint';
import { askPaste, needsPasteConfirm } from '../../services/pasteConfirm';
import { terminalShortcut, keySequenceFor } from '../../services/shortcuts';
import { readClipboard, writeClipboard } from '../../services/clipboard';
import { DEFAULT_TERMINAL_FONT } from '../../themes/fonts';
import {
  FileCode,
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
  CopyCheck,
  Settings as SettingsIcon,
  Upload,
  Key,
  Shield,
  Check
} from 'lucide-react';

type HookShell = 'bash' | 'zsh' | 'fish';

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
  /** The mouse moved into this terminal and it took the keyboard focus. */
  onHoverFocus?: () => void;
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
  onHoverFocus,
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

  // Shell the hooks were injected into, or null. Remembered per session name
  // so the picker can mark the last choice -- never used to auto-inject.
  const [hooksInjected, setHooksInjected] = useState<HookShell | null>(null);
  const hooksShellKey = `plinky_shell_hooks:${tab.sessionName}`;
  const lastHooksShell = (() => {
    try {
      return localStorage.getItem(hooksShellKey) as HookShell | null;
    } catch {
      return null;
    }
  })();
  // Shell hooks are Unix-shell scripts. Serial/Telnet/Raw tabs are usually
  // network gear (IOS, Junos, ...) whose CLI would try to run every line.
  const supportsShellHooks = !tab.protocol || tab.protocol === 'SSH';
  const [hooksError, setHooksError] = useState<string | null>(null);
  // Only consider local if it's explicitly "Local Shell" or flagged as local.
  // PuTTY sessions or SSH targets (even localhost:22) must connect via plink.
  const terminalTheme = useTerminalTheme();
  const terminalThemeRef = useRef(terminalTheme);
  terminalThemeRef.current = terminalTheme;
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
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Keep the menu inside the window. Its height varies (split actions, shell
  // hooks), so a fixed-height estimate let it run off the bottom edge.
  useLayoutEffect(() => {
    const el = contextMenuRef.current;
    if (!contextMenu || !el) return;
    const fittedTop = Math.max(8, window.innerHeight - el.getBoundingClientRect().height - 8);
    if (contextMenu.y > fittedTop) {
      setContextMenu({ x: contextMenu.x, y: fittedTop });
    }
  }, [contextMenu]);

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
  const [loggedBytes, setLoggedBytes] = useState(0);
  const [isLoggingOpen, setIsLoggingOpen] = useState(false);
  // Escape closes the topmost of this pane's own overlays. The Log and
  // Events dialogs and the context menu ignored it, so a key that closes
  // everything else in the app did nothing here.
  useEffect(() => {
    if (!contextMenu && !isEventLogOpen && !isLoggingOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (contextMenu) setContextMenu(null);
      else if (isLoggingOpen) setIsLoggingOpen(false);
      else setIsEventLogOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [contextMenu, isEventLogOpen, isLoggingOpen]);
  // The log is written to disk by the backend as output arrives; the page
  // only shows where and how much. It used to collect output in memory for an
  // export -- and collected nothing: its capture flag was never set.
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  // Also picks up a log PuTTY's own LogFileName setting started, and a log
  // still running after a reload. Polled only while logging or the panel is open.
  useEffect(() => {
    let alive = true;
    const refresh = () => sessionLogStatus(tab.id).then(info => {
      if (!alive) return;
      setIsLogging(!!info);
      setLogPath(info ? info.path : null);
      setLoggedBytes(info ? info.bytes : 0);
    }).catch(() => {});
    refresh();
    if (!isLogging && !isLoggingOpen) {
      const once = setTimeout(refresh, 1500); // a PuTTY log opens just after the spawn
      return () => { alive = false; clearTimeout(once); };
    }
    const timer = setInterval(refresh, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [tab.id, isLogging, isLoggingOpen]);

  const copyOnSelectRef = useRef(copyOnSelect);
  copyOnSelectRef.current = copyOnSelect;

  // Encrypted Vault. The backend decides which entry is this session's
  // (vault_lookup: an explicit link, or an entry named after the session or
  // host) and types it itself (vault_send_secret), so the webview never
  // holds a password to send. This used to fetch the entry once on mount:
  // unlocking the vault afterwards never reached an open tab, and locking
  // it didn't stop the tab sending the password it had cached.
  const [vault, setVault] = useState<VaultLookup | null>(null);
  const [vaultExists, setVaultExists] = useState(false);
  const vaultKey = vault?.key ?? null;
  const isVaultUnlocked = !!vault && !vault.locked;
  const [isVaultMenuOpen, setIsVaultMenuOpen] = useState(false);
  const [detectedPasswordPrompt, setDetectedPasswordPrompt] = useState<'login' | 'enable' | null>(null);
  // Unlocked in place: the notice then offers the saved password for the
  // prompt still waiting. It used to say "Vault in the top bar".
  const [unlockOpen, setUnlockOpen] = useState(false);
  // When plink was started and nothing has come back yet. An unreachable
  // host printed nothing for 35 s or more: a black terminal under a green
  // dot and a green "Terminal ready", which read as connected but hung.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [, setWaitTick] = useState(0);
  useEffect(() => {
    if (waitingSince === null) return;
    const t = setInterval(() => setWaitTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [waitingSince]);
  const cancelConnectRef = useRef<() => void>(() => {});
  // Set when a changed host key was abandoned: the pane then offers the
  // host keys, not a one-click Reconnect.
  const [hostKeyMismatch, setHostKeyMismatch] = useState<{ host: string } | null>(null);
  // Esc cancels while waiting, from the terminal itself: nothing is running
  // on the other end to take the key, and moving focus to a Cancel button
  // would leave it nowhere once the password prompt arrives.
  useEffect(() => {
    if (waitingSince === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !containerRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      cancelConnectRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [waitingSince]);
  const [copiedVaultKey, setCopiedVaultKey] = useState<'login' | 'enable' | null>(null);
  const recentOutputRef = useRef('');

  const refreshVault = useCallback(async () => {
    try {
      const found = await vaultLookup(tab.sessionName, tab.hostname, tab.username);
      setVault(found);
      if (found.locked) setVaultExists(await vaultIsInitialized());
    } catch {
      setVault(null);
    }
  }, [tab.sessionName, tab.hostname, tab.username]);

  useEffect(() => {
    void refreshVault();
    const onChange = () => void refreshVault();
    window.addEventListener(VAULT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, onChange);
  }, [refreshVault]);

  const sendVaultSecret = async (field: 'login' | 'enable') => {
    if (!vaultKey) return;
    const label = field === 'enable' ? 'enable password' : 'password';
    // Away from a password prompt the device echoes what's typed: at a shell
    // prompt the password would show on screen, run as a command and land
    // in the remote history and the session log.
    if (!detectedPasswordPrompt && !(await askConfirm({
      title: `Type the ${label} anyway?`,
      body: `No password prompt is showing. If the device echoes what is typed, the ${label} from "${vaultKey}" will be visible, and may land in its history and the session log.`,
      confirmLabel: `Type ${label}`,
      danger: true,
    }))) return;
    try {
      await vaultSendSecret(tab.id, vaultKey, field);
      addEventLog(`Sent the ${label} from vault entry "${vaultKey}"`, 'info');
      setDetectedPasswordPrompt(null);
    } catch (e) {
      addEventLog(`Vault: ${String(e)}`, 'error');
      void refreshVault();
    }
  };
  const handleSendVaultPassword = () => sendVaultSecret('login');
  const handleSendVaultEnablePassword = () => sendVaultSecret('enable');

  const copyVaultSecret = async (field: 'login' | 'enable') => {
    if (!vaultKey) return;
    try {
      // Fetched for this copy only, never kept.
      const entry = await vaultGetEntry(vaultKey);
      const secret = field === 'enable' ? entry?.enable_secret : entry?.secret;
      if (!secret) {
        addEventLog('Vault: nothing to copy (is the vault locked?)', 'warn');
        return;
      }
      await writeClipboard(secret);
      setCopiedVaultKey(field);
      setTimeout(() => setCopiedVaultKey(null), 2000);
      // The clear below can't be verified in every webview (reading the
      // clipboard back may be refused), and clipboard managers keep their own
      // history -- so the message doesn't promise it.
      addEventLog(`Copied the ${field === 'enable' ? 'enable ' : ''}password to the clipboard; Plinky will try to clear it in 25 s. A clipboard manager may keep a copy.`, 'info');
      setTimeout(async () => {
        try {
          if ((await readClipboard()) === secret) await writeClipboard('');
        } catch {
          // Can't check it's still ours, so leave the clipboard alone.
        }
      }, 25000);
    } catch (e) {
      addEventLog(`Vault: ${String(e)}`, 'error');
    }
  };
  const handleCopyVaultPassword = () => copyVaultSecret('login');
  const handleCopyVaultEnablePassword = () => copyVaultSecret('enable');

  // ---- Automatic answers (opt-in per session) ----------
  // SSH login needs none of this: plink logs in from the vault by itself.
  // What's left are prompts the device prints, which the device controls,
  // so each fires only on something the user did in this tab:
  //  - enable: right after the user typed enable/en/super (their keystrokes,
  //    not the echo) and the device asked for a password within 5 s; once.
  //  - Telnet/serial login: the device's Username:/Password: prompts, once
  //    each per connection.
  const typedRef = useRef<TypedInput>({ line: '', submitted: null });
  const autoLoginSentRef = useRef({ user: false, password: false });
  // Returns true when it answered, so the manual Send chip stays hidden.
  const autoRespondRef = useRef<(kind: 'login' | 'enable' | null, recent: string) => boolean>(() => false);
  autoRespondRef.current = (kind, recent) => {
    const v = vault;
    if (!v || v.locked || !v.key) return false;
    const key = v.key;
    const cmd = typedRef.current.submitted;
    const justAskedForEnable = !!cmd && isPrivilegeCommand(cmd.line) && Date.now() - cmd.at < 5000;
    const autoSend = (field: 'login' | 'enable') =>
      vaultSendSecret(tab.id, key, field)
        .then(() => addEventLog(`Sent the ${field === 'enable' ? 'enable password' : 'password'} automatically (vault entry "${key}")`, 'info'))
        .catch(e => addEventLog(`Vault: ${String(e)}`, 'error'));

    if (kind && justAskedForEnable) {
      if (v.autoEnable && v.hasEnableSecret) {
        typedRef.current = { ...typedRef.current, submitted: null }; // once per enable
        void autoSend('enable');
        return true;
      }
      return false; // never answer an enable prompt with the login password
    }
    const consoleLogin = v.autoLogin && (tab.protocol === 'Telnet' || tab.protocol === 'Serial');
    if (!consoleLogin) return false;
    if (isUsernamePrompt(recent) && v.username && !autoLoginSentRef.current.user) {
      autoLoginSentRef.current.user = true;
      writeTerminalInput(tab.id, new TextEncoder().encode(v.username + '\r'));
      addEventLog(`Sent the username automatically (vault entry "${key}")`, 'info');
      return true;
    }
    if (kind === 'login' && !autoLoginSentRef.current.password) {
      autoLoginSentRef.current.password = true;
      void autoSend('login');
      return true;
    }
    return false;
  };

  // ---- Paste with a delay between lines (T-015) --------------------------
  // Console ports and network gear drop characters when a config is pasted
  // at full speed. With the session's "paste line delay" set, a multi-line
  // paste is sent one line at a time by the backend (paste_paced).
  const pasteDelayRef = useRef(0);
  const [pasteJob, setPasteJob] = useState<{ sent: number; total: number } | null>(null);
  // Run Script (scripts.rs): the script running on this tab, by file name.
  const [runningScript, setRunningScript] = useState<string | null>(null);
  const autoReconnectRef = useRef(false);

  useEffect(() => {
    let active = true;
    readPuttySession(tab.sessionName)
      .then(s => {
        if (!active) return;
        pasteDelayRef.current = pasteLineDelayFrom(s?.extra);
        autoReconnectRef.current = s?.extra?.PlinkyAutoReconnect === '1';
      })
      .catch(() => {});
    const onSaved = (e: Event) => {
      const d = (e as CustomEvent<SessionSavedDetail>).detail;
      if (d?.name === tab.sessionName) {
        pasteDelayRef.current = d.pasteLineDelayMs;
        autoReconnectRef.current = d.autoReconnect;
      }
    };
    window.addEventListener(SESSION_SAVED_EVENT, onSaved);
    return () => { active = false; window.removeEventListener(SESSION_SAVED_EVENT, onSaved); };
  }, [tab.sessionName]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listenPasteProgress(p => {
      if (p.sessionId === tab.id) setPasteJob({ sent: p.sent, total: p.total });
    }).then(u => { if (disposed) u?.(); else unlisten = u; });
    return () => { disposed = true; unlisten?.(); };
  }, [tab.id]);

  // A script's notes (its stderr) and its end, shown in the terminal only.
  useEffect(() => {
    let disposed = false;
    const unlisten: (() => void)[] = [];
    const keep = (u: (() => void) | null) => { if (disposed) u?.(); else if (u) unlisten.push(u); };
    void listenScriptStarted(e => {
      if (e.sessionId === tab.id) setRunningScript(e.name);
    }).then(keep);
    void listenScriptLog(e => {
      if (e.sessionId === tab.id) terminalRef.current?.write(`\r\n\x1b[2m[script] ${e.line}\x1b[0m\r\n`);
    }).then(keep);
    void listenScriptEnded(e => {
      if (e.sessionId !== tab.id) return;
      setRunningScript(null);
      const how = e.stopped ? 'stopped' : e.code === 0 ? 'finished' : `ended with code ${e.code ?? '?'}`;
      terminalRef.current?.write(`\r\n\x1b[2m[script ${how}]\x1b[0m\r\n`);
      addEventLog(`Script ${how}`, e.stopped || e.code === 0 ? 'info' : 'warn');
    }).then(keep);
    return () => { disposed = true; unlisten.forEach(u => u()); };
  }, [tab.id]);

  const handleRunScript = async () => {
    setContextMenu(null);
    const path = await pickScriptFile();
    if (!path) return;
    const name = path.split(/[\\/]/).pop() || path;
    try {
      await runScript(tab.id, tab.sessionName, path);
      addEventLog(`Running script ${name}`, 'info');
    } catch (e) {
      terminalRef.current?.write(`\r\n\x1b[31m[Plinky: ${String(e)}]\x1b[0m\r\n`);
      addEventLog(String(e), 'error');
    }
    terminalRef.current?.focus();
  };

  /** Every paste goes through here: paced when the session asks for it. */
  const pasteText = async (text: string) => {
    if (!text) return;
    if (!isLivePtyRef.current) {
      terminalRef.current?.write(text);
      return;
    }
    const delay = pasteDelayRef.current;
    if (delay > 0 && isMultiLinePaste(text)) {
      const total = text.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;
      setPasteJob({ sent: 0, total });
      try {
        const sent = await pastePaced(tab.id, text, delay);
        addEventLog(sent < total
          ? `Paste cancelled after ${sent} of ${total} lines`
          : `Pasted ${sent} lines, ${delay} ms apart`, sent < total ? 'warn' : 'info');
      } catch (e) {
        addEventLog(String(e), 'error');
      } finally {
        setPasteJob(null);
      }
      return;
    }
    writeTerminalInput(tab.id, new TextEncoder().encode(text));
  };

  /** A paste the way the terminal itself sends one: paced when this session
   *  asks for it, otherwise through xterm (bracketed paste, line endings). */
  const deliverTypedPaste = async (text: string) => {
    if (pasteDelayRef.current > 0 && isLivePtyRef.current && isMultiLinePaste(text)) {
      await pasteText(text);
      return;
    }
    terminalRef.current?.paste(text);
  };

  /** Every paste passes the paste window first when Settings asks for it
   *  (pasteConfirm.ts); `deliver` is how this particular paste is sent. */
  const confirmThenPaste = async (text: string, deliver: (t: string) => Promise<void>) => {
    if (!text) return;
    if (needsPasteConfirm(text)) {
      const approved = await askPaste({
        text,
        target: tab.title,
        lineDelayMs: pasteDelayRef.current,
        // A password pasted at its prompt stays off the screen until asked.
        sensitive: !!detectedPasswordPrompt || classifyPasswordPrompt(recentOutputRef.current) !== null,
      });
      if (approved === null) return;
      text = approved;
    }
    await deliver(text);
  };

  /** Reads the clipboard, then pastes through the paste window. */
  const pasteFromClipboard = async (deliver: (t: string) => Promise<void>) => {
    let text: string;
    try {
      text = await readClipboard();
    } catch (e) {
      addEventLog(`Couldn't read the clipboard: ${e}`, 'error');
      return;
    }
    await confirmThenPaste(text, deliver);
  };
  // The listeners set up once per terminal reach the current versions here.
  const pasteActionsRef = useRef({ confirmThenPaste, pasteFromClipboard, deliverTypedPaste });
  pasteActionsRef.current = { confirmThenPaste, pasteFromClipboard, deliverTypedPaste };

  // ---- Reconnect (T-016) ---------------------------------------------------
  // Restarts the session in this same terminal, like PuTTY's "Restart
  // Session": the scrollback stays and the new connection continues below.
  // restartSessionRef is filled in by the mount effect, which owns the
  // terminal and its output handler.
  const restartSessionRef = useRef<(() => Promise<void>) | null>(null);
  // Network keyword highlighting (T-017), toggled per tab.
  const highlighterRef = useRef<KeywordHighlighter | null>(null);
  useEffect(() => {
    highlighterRef.current?.setEnabled(tab.activeHighlighting !== false);
  }, [tab.activeHighlighting]);
  const reachedLiveRef = useRef(false);
  // The tab's broadcast channel, for a reconnect to put the session back on.
  const syncChannelRef = useRef(tab.syncChannel);
  syncChannelRef.current = tab.syncChannel;
  const sshBannerToldRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const [reconnectIn, setReconnectIn] = useState<number | null>(null);
  // Lit briefly when a sync broadcast reaches this session (T-012).
  const broadcastGlow = useBroadcastGlow().has(tab.id);

  const cancelAutoReconnect = () => {
    if (reconnectTimerRef.current !== null) window.clearInterval(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    setReconnectIn(null);
  };

  const reconnectNow = () => {
    cancelAutoReconnect();
    void restartSessionRef.current?.();
  };

  const handleManualReconnect = () => {
    reconnectAttemptRef.current = 0;
    reconnectNow();
  };

  /**
   * After a drop from a live session: wait, then restart; the waits grow and
   * after the last one it stops, so a host that's gone isn't hammered.
   */
  const scheduleAutoReconnect = () => {
    const attempt = reconnectAttemptRef.current + 1;
    if (attempt > RECONNECT_DELAYS_S.length) {
      addEventLog(`Gave up reconnecting after ${RECONNECT_DELAYS_S.length} attempts`, 'warn');
      return;
    }
    reconnectAttemptRef.current = attempt;
    cancelAutoReconnect();
    let left = RECONNECT_DELAYS_S[attempt - 1];
    setReconnectIn(left);
    addEventLog(`Connection lost; reconnecting in ${left} s (attempt ${attempt} of ${RECONNECT_DELAYS_S.length})`, 'warn');
    reconnectTimerRef.current = window.setInterval(() => {
      left -= 1;
      if (left <= 0) reconnectNow();
      else setReconnectIn(left);
    }, 1000);
  };
  const scheduleAutoReconnectRef = useRef(scheduleAutoReconnect);
  scheduleAutoReconnectRef.current = scheduleAutoReconnect;
  useEffect(() => () => {
    if (reconnectTimerRef.current !== null) window.clearInterval(reconnectTimerRef.current);
  }, []);

  const addEventLog = useCallback((message: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
    const time = new Date().toTimeString().split(' ')[0];
    setEventLogs(prev => [...prev.slice(-200), { id: `${Date.now()}-${Math.random()}`, time, message, level }]);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm.js instance with modern dark theme
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: cursorStyle || (isFreeType ? 'bar' : 'block'),
      fontFamily: fontFamily || DEFAULT_TERMINAL_FONT,
      fontSize: fontSize || 14,
      lineHeight: 1.25,
      allowTransparency: true,
      // Find highlights matches with xterm decorations, a "proposed" API in
      // xterm 5. Without this, the first search threw "You must set the
      // allowProposedApi option" inside a React effect and blanked the view.
      allowProposedApi: true,
      // The scheme chosen in Settings; changes apply live (effect below).
      theme: terminalThemeRef.current.theme,
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
    const highlighter = new KeywordHighlighter(term, tab.activeHighlighting !== false);
    highlighterRef.current = highlighter;
    highlighter.setTheme(terminalThemeRef.current.theme, !!terminalThemeRef.current.light);
    // Output arrives in many small chunks; decorate them in one pass a few
    // ms later. (setTimeout, not requestAnimationFrame: rAF doesn't run
    // while the window is hidden, and highlights would lag behind output.)
    let scanQueued = false;
    const scheduleHighlight = () => {
      if (scanQueued) return;
      scanQueued = true;
      window.setTimeout(() => {
        scanQueued = false;
        if (!disposed) highlighter.scan();
      }, 30);
    };
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
              void writeClipboard(ip);
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

    // Set once this view unmounts. Unmounting (switching tabs, a split pane
    // re-render) must NOT kill the backend session -- it's detached, not
    // closed, and the next mount reattaches with scrollback replay. Only an
    // explicit tab close ends a session. Async work started by this effect
    // checks the flag so a stale view never writes to its disposed terminal
    // or spawns a second process for the same tab.
    let disposed = false;

    // Subscribe to native host key prompt events from backend
    let unlistenPrompts: (() => void) | null = null;
    listenHostKeyPrompts((event) => {
      if (event.session_id === tab.id) {
        // The server answered: this is no longer "connecting", and Esc now
        // belongs to the host-key dialog (it cancelled the connection too,
        // printing "Connection cancelled" above the mismatch report).
        setWaitingSince(null);
        setPendingPrompt(event.prompt);
        onUpdateTab(tab.id, { status: 'preauth' });
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten?.();
      } else {
        unlistenPrompts = unlisten;
      }
    });

    // Tells the backend what this page has drawn, so a flood waits for it
    // (ADR-006). Only live output counts: a replay was never sent by the
    // backend, so there is nothing to acknowledge.
    const acker = createOutputAcker(tab.id);
    const handleIncomingChunk = (chunk: Uint8Array, live = true) => {
      if (disposed) return;
      isLivePtyRef.current = true;
      if (chunk.length > 0) setWaitingSince(null);
      term.write(chunk, () => {
        scheduleHighlight();
        if (live) acker.ack(chunk.length);
      });
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
      // A telnet/raw console (GNS3) has no login messages and often no prompt
      // until Enter: any output at all means it is connected (T-020).
      const isConsoleTarget = tab.protocol === 'Telnet' || tab.protocol === 'RAW';
      const isLivePattern = (
        text.includes('Access granted') || 
        text.includes('Last login:') || 
        /(?:[\$#%❯]\s*)$/m.test(text.trim())
      );

      // Password & enable prompt detection, on the tail of the output so a
      // prompt split across chunks, or IOS's "enable" then "Password:", is seen.
      recentOutputRef.current = appendRecentOutput(recentOutputRef.current, text);
      const promptKind = classifyPasswordPrompt(recentOutputRef.current);
      const isEnablePrompt = promptKind === 'enable';
      const isPasswordPrompt = promptKind !== null;
      const answeredAutomatically = autoRespondRef.current(promptKind, recentOutputRef.current);

      const hint = live ? fatalHint(text, tab.hostname, tab.port) : null;
      if (hint) term.writeln(`\x1b[33m[Plinky: ${hint}]\x1b[0m`);
      const mismatch = sshBannerToldRef.current ? null : sshBannerHint(recentOutputRef.current, tab.protocol);
      if (mismatch) {
        sshBannerToldRef.current = true;
        term.writeln(`\r\n\x1b[33m[Plinky: ${mismatch}]\x1b[0m`);
      }
      if (text.includes('[Plinky: Session closed') || text.includes('FATAL ERROR:')) {
        onUpdateTab(tab.id, { status: 'disconnected' });
        setDetectedPasswordPrompt(null);
        // A FATAL ERROR after the session was live is a dropped connection
        // ("Remote side unexpectedly closed", "Network error: ..."). A clean
        // `exit` prints no FATAL, and a failed login never reached live --
        // neither reconnects on its own.
        const networkProtocol = !tab.protocol || tab.protocol === 'SSH' || tab.protocol === 'Telnet';
        if (text.includes('FATAL ERROR:') && reachedLiveRef.current && autoReconnectRef.current && networkProtocol) {
          reachedLiveRef.current = false;
          scheduleAutoReconnectRef.current();
        }
        reachedLiveRef.current = false;
      } else if (isPreauthPattern && !reachedLiveRef.current) {
        // Only before the login is over. After it, text that looks like a
        // login is the session's own output: Windows' pseudo-console
        // repaints plink's whole screen (the old "password:" included)
        // when the tab tells it its size on reattach, and a router's
        // `enable` asks "Password:". Either turned a live tab amber. The
        // prompt is still noticed below, for the vault's offer.
        onUpdateTab(tab.id, { status: 'preauth' });
        if (isEnablePrompt) {
          setDetectedPasswordPrompt('enable');
        } else if (isPasswordPrompt) {
          setDetectedPasswordPrompt('login');
        }
      } else if (isLivePattern || (isConsoleTarget && !reachedLiveRef.current && text.length > 0)) {
        if (!reachedLiveRef.current && live) addEventLog(isLocalSession ? 'Shell ready' : 'Connected', 'success');
        onUpdateTab(tab.id, { status: 'live' });
        setDetectedPasswordPrompt(null);
        reachedLiveRef.current = true;
        reconnectAttemptRef.current = 0; // back up: the next drop starts over
      } else if (isEnablePrompt) {
        setDetectedPasswordPrompt('enable');
      } else if (isPasswordPrompt) {
        setDetectedPasswordPrompt('login');
      }
      if (answeredAutomatically) setDetectedPasswordPrompt(null);
    };

    // PuTTY Classic: Copy on select
    term.onSelectionChange(() => {
      if (copyOnSelectRef.current) {
        const selection = term.getSelection();
        if (selection && selection.length > 0) void writeClipboard(selection);
      }
    });

    // The connection is up (the backend watches plink's socket). A router
    // console prints nothing until something happens on the device -- 0
    // bytes in 5 s on a GNS3 IOS console -- so "Connecting to host:port"
    // can't wait for output: it stayed up ~10 s on saved console sessions.
    // A telnet or raw console is live from here; SSH still has to log in.
    const onConnected = () => {
      if (disposed) return;
      setWaitingSince(null);
      if ((tab.protocol === 'Telnet' || tab.protocol === 'RAW') && !reachedLiveRef.current) {
        reachedLiveRef.current = true;
        reconnectAttemptRef.current = 0;
        addEventLog('Connected', 'success');
        onUpdateTab(tab.id, { status: 'live' });
      }
    };
    let unlistenConnected: (() => void) | null = null;
    void listenSessionConnected(id => { if (id === tab.id) onConnected(); })
      .then(u => { if (disposed) u?.(); else unlistenConnected = u; });

    const startFresh = () => {
      // A reconnect closed the old session, which took it off its channel.
      setSyncChannel(tab.id, syncChannelRef.current === 'none' ? null : syncChannelRef.current);
      // Fresh start
      addEventLog(isLocalSession
        ? 'Starting local shell'
        : `Connecting to ${tab.hostname || tab.sessionName}${tab.port ? `:${tab.port}` : ''}`, 'info');
      if (!isLocalSession && isTauriEnvironment()) setWaitingSince(Date.now());
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
        (tab as any).logFileName,
        targetProtocolOf(tab.protocol)
      ).then(({ started, error }) => {
        if (disposed) {
          // Tab closed while the spawn was in flight: its close ran as a
          // no-op before this session existed, so close the straggler now.
          if (started && isSessionClosed(tab.id)) {
            closeTerminalSession(tab.id);
          }
          return;
        }
        if (started) {
          isLivePtyRef.current = true;
        }
        if (!started) {
          setWaitingSince(null);
          onUpdateTab(tab.id, { status: 'disconnected' });
          if (isTauriEnvironment()) {
            const reason = error || 'Verify that PuTTY (plink) is installed and target host is reachable.';
            term.writeln(`\r\n\x1b[31m[Plinky Error: Failed to start session "${tab.sessionName}": ${reason}]\x1b[0m\r\n`);
            addEventLog(`Failed to start session "${tab.sessionName}": ${reason}`, 'error');
          } else {
            // Browser development preview fallback banner (non-Tauri mode)
            term.writeln(`\x1b[33m[Plinky: Running in Web Browser Dev Mode - Desktop Tauri Backend Inactive]\x1b[0m\r\n`);
            addEventLog("Running in browser development preview mode", 'info');
            onUpdateTab(tab.id, { status: 'live' });
          }
        } else {
          // The process is up; the connection is not. "Connected" is logged
          // when the login actually finishes.
          const isSerial = tab.protocol === 'Serial';
          addEventLog(
            isLocalSession ? 'Local shell started' : isSerial ? 'Serial line opened' : 'plink started, waiting for the server',
            'info',
          );
          if (isLocalSession || isSerial) {
            // No login to wait for: a local shell or a serial line is up
            // once it starts. Its prompt can't be the sign: Windows' ends in
            // ">" ("C:\Users\ops>"), which the live pattern never matched,
            // so a Local Shell tab spun "connecting" forever (Windows 11 VM),
            // and a router on a serial line may print nothing at all.
            reachedLiveRef.current = true;
            setWaitingSince(null);
            onUpdateTab(tab.id, { status: 'live' });
          } else {
            // Connected before this page listened: the event went by.
            void isSessionConnected(tab.id).then(c => { if (c) onConnected(); });
          }
        }
      });
    };

    cancelConnectRef.current = () => {
      if (disposed) return;
      setWaitingSince(null);
      void closeTerminalSession(tab.id);
      onUpdateTab(tab.id, { status: 'disconnected' });
      term.writeln('\r\n\x1b[33m[Plinky: Connection cancelled]\x1b[0m');
      addEventLog('Connection cancelled', 'warn');
    };

    // Reconnect: close whatever is left of the old session and start again
    // under the same tab id, in this terminal.
    restartSessionRef.current = async () => {
      if (disposed) return;
      setHostKeyMismatch(null);
      await closeTerminalSession(tab.id);
      reopenSessionId(tab.id);
      if (disposed) return;
      recentOutputRef.current = '';
      reachedLiveRef.current = false; // a new login, shown as one
      typedRef.current = { line: '', submitted: null };
      autoLoginSentRef.current = { user: false, password: false };
      setDetectedPasswordPrompt(null);
      term.writeln('\r\n\x1b[33m[Plinky: Reconnecting...]\x1b[0m');
      onUpdateTab(tab.id, { status: 'connecting' });
      startFresh();
    };

    // Attempt to reattach to existing session or start a new PTY session.
    // A console tab opened in the background (T-020) may still be starting:
    // wait for it, then attach, instead of starting a second session.
    (backgroundStartOf(tab.id) ?? Promise.resolve())
      .then(() => (disposed ? null : attachTerminalSession(tab.id, 0, handleIncomingChunk)))
      .then((attachInfo) => {
        if (disposed) return;
        if (attachInfo) {
          isLivePtyRef.current = true;
          // A session started before this view (a console from GNS3, a
          // background tab) began at 120x32. The resize observer fired
          // before the attach, while nothing was live, so tell it the real
          // size now: telnet passes it on, and Cisco IOS wraps by it.
          if (term.cols && term.rows) resizeTerminal(tab.id, term.cols, term.rows);
          // A host-key prompt raised while this tab was in the background was
          // broadcast to no listener; the backend still blocks input for it,
          // so re-show the dialog or the session is stuck.
          if (attachInfo.pending_prompt) {
            setPendingPrompt(attachInfo.pending_prompt);
          }
          // The backend knows whether the login is over; the replay below
          // holds the old login prompt and must not decide it.
          reachedLiveRef.current = attachInfo.is_live;
          if (attachInfo.replay_data && attachInfo.replay_data.length > 0) {
            handleIncomingChunk(new Uint8Array(attachInfo.replay_data), false);
            addEventLog(`Attached to active session "${tab.sessionName}" with replayed scrollback`, 'success');
          } else {
            addEventLog(`Attached to active session "${tab.sessionName}"`, 'success');
          }
          // An ended session is disconnected: "not live" alone read as a
          // login still pending, and a refused console showed the amber key.
          onUpdateTab(tab.id, { status: attachInfo.ended ? 'disconnected' : attachInfo.is_live ? 'live' : 'preauth' });
          reachedLiveRef.current = attachInfo.is_live;
        } else {
          startFresh();
        }
      });

    // A paste the webview performs itself (its own paste key, a middle
    // click) reaches xterm as a DOM paste event on its textarea. When the
    // paste window should ask first, or this session paces multi-line
    // pastes, take it here (capture phase, before xterm); otherwise xterm
    // pastes as usual (bracketed paste and all).
    const pasteTarget = containerRef.current;
    const onPasteCapture = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const paced = pasteDelayRef.current > 0 && isLivePtyRef.current && isMultiLinePaste(text);
      if (paced || needsPasteConfirm(text)) {
        e.preventDefault();
        e.stopPropagation();
        const a = pasteActionsRef.current;
        void a.confirmThenPaste(text, t => pasteActionsRef.current.deliverTypedPaste(t));
      }
    };
    pasteTarget?.addEventListener('paste', onPasteCapture, true);

    // Copy, paste and select all (shortcuts.ts). Handled here, not left to
    // the webview: WebKitGTK and WebView2 disagree on which of these keys
    // paste by themselves. preventDefault stops the webview's own paste,
    // which would otherwise arrive as a second, unconfirmed one. Copy with
    // nothing selected does nothing -- it must not reach the device as ^C.
    term.attachCustomKeyEventHandler((e) => {
      const sequence = keySequenceFor(e, isLocalSession);
      if (sequence) {
        e.preventDefault();
        if (e.type === 'keydown') term.input(sequence, true);
        return false;
      }
      const action = terminalShortcut(e);
      if (!action) return true;
      e.preventDefault();
      if (e.type !== 'keydown') return false;
      if (action === 'copy') {
        const selection = term.getSelection();
        if (selection) void writeClipboard(selection);
      } else if (action === 'selectAll') {
        term.selectAll();
      } else {
        void pasteActionsRef.current.pasteFromClipboard(t => pasteActionsRef.current.deliverTypedPaste(t));
      }
      return false;
    });

    // Handle user keyboard input
    term.onData((data) => {
      typedRef.current = trackTypedInput(typedRef.current, data, Date.now());
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
      // e.code, not e.key: on a Greek layout the F key types "φ".
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
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
      restartSessionRef.current = null;
      unlistenConnected?.();
      pasteTarget?.removeEventListener('paste', onPasteCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (unlistenPrompts) {
        unlistenPrompts();
      }
      // The session keeps its broadcast channel: unmounting is switching
      // tabs, not leaving the channel. Clearing it here left every tab not
      // on screen -- and the one on screen, after one round trip -- off its
      // channel in the backend while its badge still said B: "Not sent: no
      // live session on CH-B" with two live routers on B. Closing the tab
      // takes it off (the backend's close_session).
      terminalManager.unregisterTerminal(tab.id);
      // Nothing will draw this session's output now: let it run into
      // scrollback rather than wait for acknowledgements (ADR-006).
      acker.dispose();
      if (!isSessionClosed(tab.id)) void detachTerminalSession(tab.id);
      osc133Disposable.dispose();
      osc7Disposable.dispose();
      disposed = true;
      highlighter.dispose();
      highlighterRef.current = null;
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

    // A search must never take the terminal down with it (an invalid regex,
    // or an xterm error): report it and keep the view.
    try {
      if (direction === 'next') {
        searchAddonRef.current.findNext(searchQuery, options);
      } else {
        searchAddonRef.current.findPrevious(searchQuery, options);
      }
    } catch (e) {
      setSearchStats(null);
      console.warn('Search failed:', e);
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

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme.theme;
    highlighterRef.current?.setTheme(terminalTheme.theme, !!terminalTheme.light);
  }, [terminalTheme]);

  // WindTerm Free Type Mode: Arbitrary cursor placement and delta computation
  // Focus follows the mouse into a terminal, so a split or grid pane can be
  // typed into without clicking it first. Never while something else is
  // being typed into (broadcast bar, search, a dialog field) or while a
  // button is held (a text selection dragged across panes).
  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!shouldTakeHoverFocus(e.buttons, document.activeElement, !!pendingPrompt)) return;
    terminalRef.current?.focus();
    onHoverFocus?.();
  };

  // And while the mouse stays over it: after a menu closes, a button is
  // clicked or a dialog shuts, the mouse is already inside and no enter
  // comes, so the terminal stayed without the keyboard (owner: "if the
  // mouse is over the terminal, the focus should be on the terminal").
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const term = terminalRef.current;
    if (!term || contextMenu || document.activeElement === term.textarea) return;
    if (!shouldTakeHoverFocus(e.buttons, document.activeElement, !!pendingPrompt)) return;
    term.focus();
    onHoverFocus?.();
  };

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
    setContextMenu({ x, y: e.clientY });
  };

  const handleCopy = () => {
    const selection = terminalRef.current?.getSelection();
    if (selection) void writeClipboard(selection);
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
    void writeClipboard(fullText.trimEnd());
    addEventLog(`Copied entire scrollback (${buffer.length} lines) to clipboard`, 'info');
    setContextMenu(null);
  };

  // The menu's Paste (and a right click set to paste) sends what the paste
  // keys send. It wrote the clipboard raw: a line break reached a router as
  // LF, and text copied on Windows as CR LF, two Enters per line, where
  // Ctrl+Shift+V sends each line with one Enter (e2e suite).
  const handlePaste = async () => {
    setContextMenu(null);
    await pasteFromClipboard(deliverTypedPaste);
    // Back to the terminal, not the menu item that was just removed.
    terminalRef.current?.focus();
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

  const handleAnswerPrompt = async (answer: 'store' | 'once' | 'reject') => {
    const prompt = pendingPrompt;
    await answerHostKeyPrompt(tab.id, answer);
    setPendingPrompt(null);
    if (answer === 'reject' && prompt?.changed) {
      // Abandoning a changed key used to end like any failed connect: a
      // generic closed line and a Reconnect button, the easiest thing to
      // click at the one moment an attacker could be in the middle.
      const stored = await storedFingerprint(prompt);
      const where = `${prompt.host}:${prompt.port}`;
      terminalRef.current?.writeln(
        `\r\n\x1b[1;31m[Plinky: the host key for ${where} does not match the one PuTTY saved. Connection abandoned.]\x1b[0m` +
        `\r\n\x1b[31m  Offered: ${prompt.fingerprint || 'unknown'}\x1b[0m` +
        (stored ? `\r\n\x1b[31m  Saved:   ${stored}\x1b[0m` : '') +
        `\r\n\x1b[31m  Check the offered fingerprint with the server's administrator before trusting it.\x1b[0m\r\n`
      );
      addEventLog(`Host key mismatch for ${where}; connection abandoned`, 'error');
      setHostKeyMismatch({ host: prompt.host });
    }
    terminalRef.current?.focus();
  };

  // A menu, not a cycle: clicking through Off, A, B, C, D showed nothing
  // of what came next and meant counting clicks to reach a channel.
  const [channelMenuOpen, setChannelMenuOpen] = useState(false);
  useEffect(() => {
    if (!channelMenuOpen) return;
    const close = () => setChannelMenuOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey, true); };
  }, [channelMenuOpen]);

  const chooseChannel = (nextChannel: SyncChannel) => {
    setChannelMenuOpen(false);
    onUpdateTab(tab.id, { syncChannel: nextChannel }); // the effect below tells the backend
    terminalManager.setSyncChannel(tab.id, nextChannel);
  };

  // The backend's router decides who gets a broadcast; the tab's channel is
  // what the user chose. Told on every mount (a tab shown again, a restored
  // layout) and on every change, so the two can't drift apart.
  useEffect(() => {
    void setSyncChannel(tab.id, tab.syncChannel === 'none' ? null : tab.syncChannel);
  }, [tab.id, tab.syncChannel]);

  const handleInjectHooks = async (shell: HookShell) => {
    setHooksError(null);
    setContextMenu(null);
    if (hooksInjected) {
      setHooksError(`Shell hooks are already active (${hooksInjected}).`);
      setTimeout(() => setHooksError(null), 4000);
      return;
    }
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
      // The shell must match: this used to always send the bash script. In
      // zsh its `trap ... DEBUG` also fires inside command substitutions,
      // leaking OSC bytes into prompt themes' arithmetic ("bad math
      // expression: illegal character: ^["), and zsh ignores PROMPT_COMMAND.
      const ok = await injectShellIntegration(tab.id, shell);
      if (ok) {
        setHooksInjected(shell);
        try {
          localStorage.setItem(hooksShellKey, shell);
        } catch {
          // Remembering the choice is a convenience only.
        }
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
      case 'A': return 'bg-ch-a/20 text-ch-a border-ch-a/40';
      case 'B': return 'bg-ch-b/20 text-ch-b border-ch-b/40';
      case 'C': return 'bg-ch-c/20 text-ch-c border-ch-c/40';
      case 'D': return 'bg-ch-d/20 text-ch-d border-ch-d/40';
      default: return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  return (
    <div 
      className="relative flex flex-col h-full w-full bg-plinky-950 overflow-hidden"
      onContextMenu={handleContextMenu}
    >
      {/* Broadcast glow: an overlay, since an inset shadow on this element
          would be painted under the terminal canvas. */}
      <div
        aria-hidden
        data-broadcast-glow={broadcastGlow ? 'on' : 'off'}
        className="pointer-events-none absolute inset-0 z-30"
        style={{
          boxShadow: `inset 0 0 0 2px ${glowColor(tab.syncChannel)}, inset 0 0 28px ${glowColor(tab.syncChannel, 0.4)}`,
          opacity: broadcastGlow ? 1 : 0,
          transition: `opacity ${broadcastGlow ? 120 : 700}ms ease-out`,
        }}
      />
      {/* Tab Control Overlay Header */}
      <div className="relative flex items-center justify-between gap-3 px-3 py-1.5 bg-plinky-900/90 border-b border-plinky-800 text-xs select-none whitespace-nowrap">
        <div className="flex items-center space-x-2 min-w-0">
          <span
            role="img"
            aria-label={STATUS_TEXT[tab.status]}
            title={STATUS_TEXT[tab.status]}
            className={`h-2 w-2 rounded-full ${STATUS_DOT[tab.status]}`}
          />
          <span className="font-semibold text-slate-200 truncate">{tab.sessionName}</span>
          {/* Quick-connect tabs are named after their target already; the
              header read "Quick (127.0.0.1:1) (127.0.0.1:1)". */}
          {(isLocalSession || !tab.sessionName.includes(`${tab.hostname}:${tab.port}`)) && (
            <span className="text-plinky-muted font-mono truncate">
              {isLocalSession ? '(local shell)' : `(${tab.hostname}:${tab.port})`}
            </span>
          )}
        </div>

        {hooksError && (
          <div className="absolute top-full right-3 mt-1 z-40 px-2 py-1 rounded bg-rose-950/95 border border-rose-500/50 text-rose-300 text-meta shadow-lg animate-in fade-in slide-in-from-top-1 duration-150">
            {hooksError}
          </div>
        )}
        <div className="flex items-center space-x-2">
          {/* Encrypted Vault Credentials Quick Action */}
          {vaultKey && (
            <div className="relative">
              <button
                onClick={() => {
                  if (!isVaultMenuOpen) void refreshVault();
                  setIsVaultMenuOpen(prev => !prev);
                }}
                title={`Encrypted Vault: ${vaultKey}`}
                className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-meta font-medium transition-colors ${
                  isVaultMenuOpen
                    ? 'bg-sky-500/15 text-sky-200 border-sky-500/40'
                    : 'bg-slate-800/80 text-slate-300 border-plinky-700 hover:bg-slate-700 hover:text-slate-100'
                }`}
              >
                <Key className="w-3 h-3 text-slate-400" />
                <span>Vault</span>
              </button>

              {isVaultMenuOpen && (
                <div 
                  className="absolute right-0 top-full mt-1.5 z-40 w-56 bg-plinky-900 border border-plinky-700 rounded-lg shadow-2xl py-1.5 text-xs select-none backdrop-blur-md animate-in fade-in duration-100"
                  onClick={e => e.stopPropagation()}
                >
                  <div className="px-3 py-1 border-b border-plinky-800 flex items-center justify-between">
                    <span className="font-semibold text-slate-200 text-meta">Vault Credentials</span>
                    <span className="text-meta text-plinky-muted font-mono truncate max-w-[100px]" title={vaultKey}>
                      {vaultKey}
                    </span>
                  </div>

                  {!isVaultUnlocked ? (
                    <div className="p-2.5 text-center space-y-1.5">
                      <p className="text-meta text-slate-400">Vault is currently locked.</p>
                      <p className="text-meta text-plinky-muted">Unlock it with Vault in the top bar to send saved passwords.</p>
                    </div>
                  ) : (
                    <div className="py-1">
                      <button
                        onClick={() => {
                          handleSendVaultPassword();
                          setIsVaultMenuOpen(false);
                        }}
                        className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
                      >
                        <Zap className="w-3.5 h-3.5 text-slate-400" />
                        <span>Send Login Password</span>
                      </button>

                      {vault?.hasEnableSecret && (
                        <button
                          onClick={() => {
                            handleSendVaultEnablePassword();
                            setIsVaultMenuOpen(false);
                          }}
                          className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/20 hover:text-sky-100 text-left transition"
                        >
                          <Shield className="w-3.5 h-3.5 text-slate-400" />
                          <span>Send Enable Password</span>
                        </button>
                      )}

                      <div className="border-t border-plinky-800 my-1" />

                      <button
                        onClick={handleCopyVaultPassword}
                        className="w-full flex items-center justify-between px-3 py-1 hover:bg-slate-800 text-slate-300 text-left text-meta transition"
                      >
                        <span className="flex items-center space-x-1.5">
                          <Copy className="w-3 h-3 text-slate-400" />
                          <span>Copy Password</span>
                        </span>
                        {copiedVaultKey === 'login' && <Check className="w-3 h-3 text-emerald-400" />}
                      </button>

                      {vault?.hasEnableSecret && (
                        <button
                          onClick={handleCopyVaultEnablePassword}
                          className="w-full flex items-center justify-between px-3 py-1 hover:bg-slate-800 text-slate-300 text-left text-meta transition"
                        >
                          <span className="flex items-center space-x-1.5">
                            <Copy className="w-3 h-3 text-slate-400" />
                            <span>Copy Enable Password</span>
                          </span>
                          {copiedVaultKey === 'enable' && <Check className="w-3 h-3 text-emerald-400" />}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Find In Terminal Button */}
          <button
            onClick={() => {
              setIsSearchOpen(true);
              setTimeout(() => searchInputRef.current?.focus(), 50);
            }}
            title="Find in Terminal (Ctrl+F)"
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-meta transition"
          >
            <Search className="w-3 h-3 text-sky-400" />
            <span>Find</span>
          </button>

          {/* Sync Input Channel Badge */}
          <div className="relative">
            <button
              onClick={() => setChannelMenuOpen(v => !v)}
              onPointerDown={e => e.stopPropagation()}
              aria-haspopup="menu"
              aria-expanded={channelMenuOpen}
              title="Broadcast channel: commands sent to a channel reach every live tab on it"
              className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-meta whitespace-nowrap transition-colors ${getChannelColor(tab.syncChannel)}`}
            >
              <Radio className="w-3 h-3" />
              <span>Channel: {tab.syncChannel === 'none' ? 'Off' : tab.syncChannel}</span>
            </button>
            {channelMenuOpen && (
              <div
                role="menu"
                aria-label="Broadcast channel"
                onPointerDown={e => e.stopPropagation()}
                className="absolute right-0 top-full mt-1 z-40 w-40 py-1 rounded-lg border border-plinky-700 bg-plinky-900 shadow-xl text-xs"
              >
                {(['none', 'A', 'B', 'C', 'D'] as const).map(ch => (
                  <button
                    key={ch}
                    role="menuitemradio"
                    aria-checked={tab.syncChannel === ch}
                    onClick={() => chooseChannel(ch)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-plinky-800 ${tab.syncChannel === ch ? 'text-slate-100' : 'text-slate-300'}`}
                  >
                    <span className={`w-5 text-center rounded border text-meta font-semibold ${ch === 'none' ? 'border-plinky-700 text-plinky-muted' : getChannelColor(ch)}`}>
                      {ch === 'none' ? '·' : ch}
                    </span>
                    <span className="flex-1">{ch === 'none' ? 'Off' : `Channel ${ch}`}</span>
                    {tab.syncChannel === ch && <Check className="w-3 h-3 text-sky-400" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Keyword highlighting toggle (T-017). This used to be a static
              "Regex Hi" label claiming highlighting that didn't exist. */}
          <button
            onClick={() => onUpdateTab(tab.id, { activeHighlighting: tab.activeHighlighting === false })}
            aria-pressed={tab.activeHighlighting !== false}
            title={tab.activeHighlighting !== false
              ? 'Keyword highlighting on: errors and down states red, warnings amber, up green, interfaces, IPs and MACs. Click to turn off.'
              : 'Keyword highlighting off. Click to turn on.'}
            className={`flex items-center space-x-1 px-1.5 py-0.5 rounded border text-meta transition ${
              tab.activeHighlighting !== false
                ? 'bg-sky-500/15 text-sky-300 border-sky-500/40 hover:bg-sky-500/25'
                : 'bg-slate-800/60 text-plinky-muted border-slate-700 hover:text-slate-300'
            }`}
          >
            <Sparkles className="w-3 h-3" />
            <span>Highlight</span>
          </button>

          {/* PuTTY Session Logging Button */}
          <button
            onClick={() => setIsLoggingOpen(true)}
            title="Session Logging (PuTTY-style) - record output to log file"
            className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-meta transition-colors ${
              isLogging
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/50'
                : 'bg-slate-800/80 text-slate-400 border-slate-700 hover:text-slate-300'
            }`}
          >
            {isLogging ? (
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400"></span>
            ) : (
              <FileText className="w-3 h-3 text-slate-400" />
            )}
            <span>{isLogging ? `Log: ${(loggedBytes / 1024).toFixed(1)}k` : 'Log'}</span>
          </button>

          {/* PuTTY Event Log Button */}
          <button
            onClick={() => setIsEventLogOpen(true)}
            title="PuTTY Event Log - view connection diagnostics and trace"
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 border border-slate-700 text-meta transition"
          >
            <List className="w-3 h-3 text-slate-400" />
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
            aria-label="Find in terminal"
              placeholder="Find in terminal…"
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
            className="w-44 bg-plinky-950 border border-plinky-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
          />

          {/* Search Result Counter */}
          <span className="text-meta font-mono text-slate-400 px-1 min-w-[50px] text-center">
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
            className={`px-1.5 py-0.5 rounded text-meta font-bold border transition ${
              caseSensitive ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-plinky-muted border-transparent hover:text-slate-300'
            }`}
          >
            Aa
          </button>
          <button
            onClick={() => setWholeWord(!wholeWord)}
            title="Match Whole Word"
            className={`px-1.5 py-0.5 rounded text-meta font-bold border transition ${
              wholeWord ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-plinky-muted border-transparent hover:text-slate-300'
            }`}
          >
            \b
          </button>
          <button
            onClick={() => setIsRegex(!isRegex)}
            title="Use Regular Expression"
            className={`px-1.5 py-0.5 rounded text-meta font-bold border transition ${
              isRegex ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-plinky-muted border-transparent hover:text-slate-300'
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
            className="p-1 text-plinky-muted hover:text-rose-400 ml-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Terminal Viewport */}
      <div
        ref={containerRef}
        onClick={handleCanvasClick}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex-1 relative w-full h-full overflow-hidden ${isFreeType ? 'free-type-active' : ''}`}
        // The strip around the character grid takes the scheme's background,
        // or a light scheme sat in a dark frame.
        style={{ background: terminalTheme.theme.background }}
      >
        {/* Drag and Drop File Path Overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-30 pointer-events-none border-2 border-dashed border-sky-400 bg-sky-950/70 backdrop-blur-xs flex items-center justify-center text-sky-300 font-mono text-xs space-x-2 animate-in fade-in duration-100">
            <Upload className="w-5 h-5 text-sky-400 animate-bounce" />
            <span>Drop file to paste path into terminal</span>
          </div>
        )}

        {/* Reconnect (T-016) */}
        {waitingSince !== null && (
          <div
            role="status"
            className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none"
          >
            <div
              className="pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-lg border border-plinky-700 bg-plinky-900/95 shadow-2xl text-xs text-slate-200"
            >
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" aria-hidden />
              <span>
                Connecting to <span className="font-mono text-slate-100">{tab.hostname || tab.sessionName}{tab.port ? `:${tab.port}` : ''}</span>
                <span className="text-plinky-muted tabular-nums"> · {Math.max(0, Math.floor((Date.now() - waitingSince) / 1000))} s</span>
              </span>
              <button
                onClick={() => cancelConnectRef.current()}
                title="Esc"
                className="px-2 py-0.5 rounded border border-plinky-700 text-slate-300 hover:bg-plinky-800 outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {hostKeyMismatch && tab.status === 'disconnected' && reconnectIn === null && (
          <div role="alert" className="absolute bottom-3 left-4 z-30 flex items-center space-x-2 bg-plinky-900/95 border border-rose-500/70 text-rose-200 px-3 py-1.5 rounded-lg shadow-2xl text-xs">
            <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
            <span>Host key changed. Connection abandoned.</span>
            <button onClick={() => showHostKeys(hostKeyMismatch.host)} className="px-2 py-0.5 rounded border border-rose-500/50 text-rose-200 hover:bg-rose-500/10 text-meta">View host keys</button>
          </div>
        )}
        {!hostKeyMismatch && (reconnectIn !== null || tab.status === 'disconnected') && (
          <div role="status" className="absolute bottom-3 left-4 z-30 flex items-center space-x-2 bg-plinky-900/95 border border-amber-500/60 text-amber-200 px-3 py-1.5 rounded-lg shadow-2xl text-xs">
            <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
            {reconnectIn !== null ? (
              <>
                <span>Connection lost. Reconnecting in {reconnectIn} s</span>
                <button onClick={reconnectNow} className="px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-400 text-amber-950 text-meta">Reconnect now</button>
                <button onClick={cancelAutoReconnect} className="px-2 py-0.5 rounded bg-plinky-800 hover:bg-plinky-700 text-slate-200 text-meta">Cancel</button>
              </>
            ) : (
              <>
                <span>Disconnected</span>
                <button onClick={handleManualReconnect} className="px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-400 text-amber-950 text-meta">Reconnect</button>
              </>
            )}
          </div>
        )}

        {/* Paced paste in progress (T-015): how far, and a way to stop it. */}
        {runningScript && (
          <div role="status" className="absolute bottom-3 left-3 z-30 flex items-center space-x-2 bg-plinky-900/95 border border-sky-500/60 text-sky-200 px-3 py-1.5 rounded-lg shadow-2xl text-xs">
            <FileCode className="w-3.5 h-3.5 text-sky-400 animate-pulse" />
            <span>Running {runningScript}</span>
            <button
              // Stop ends the script and sends Ctrl+C to what it started
              // (scripts.rs); the keyboard goes back to the terminal, which
              // was left on this button (owner).
              onClick={() => { void stopScript(tab.id); terminalRef.current?.focus(); }}
              className="px-2 py-0.5 rounded bg-plinky-800 hover:bg-rose-600/60 text-slate-200 text-meta"
            >
              Stop
            </button>
          </div>
        )}

        {pasteJob && (
          <div role="status" className="absolute bottom-3 right-14 z-30 flex items-center space-x-2 bg-plinky-900/95 border border-sky-500/60 text-sky-200 px-3 py-1.5 rounded-lg shadow-2xl text-xs">
            <Clipboard className="w-3.5 h-3.5 text-sky-400 animate-pulse" />
            <span>Pasting line {Math.min(pasteJob.sent + 1, pasteJob.total)} of {pasteJob.total}</span>
            <button
              onClick={() => { void cancelPaste(tab.id); }}
              className="px-2 py-0.5 rounded bg-plinky-800 hover:bg-rose-600/60 text-slate-200 text-meta"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Vault autofill at a password prompt. Names the entry it will
            use: prompt detection reads text the remote side controls, so
            after hopping to another host the prompt may not be this
            session's. An enable prompt is only offered an enable password. */}
        {detectedPasswordPrompt && vaultKey && isVaultUnlocked &&
          (detectedPasswordPrompt === 'login' || vault?.hasEnableSecret) && (
          <div className="absolute top-3 right-14 z-30 flex items-center space-x-2 bg-plinky-900/95 border border-amber-500/60 text-amber-200 px-3 py-1.5 rounded-lg shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-150 text-xs">
            <Key className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
            <span className="font-medium">
              {detectedPasswordPrompt === 'enable' ? 'Enable password prompt' : 'Password prompt'}
            </span>
            <button
              onClick={detectedPasswordPrompt === 'enable' ? handleSendVaultEnablePassword : handleSendVaultPassword}
              title={`Types the ${detectedPasswordPrompt === 'enable' ? 'enable ' : ''}password saved in vault entry "${vaultKey}"`}
              className="px-2.5 py-0.5 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-meta transition shadow-xs flex items-center space-x-1"
            >
              <span>{detectedPasswordPrompt === 'enable' ? 'Send enable password' : 'Send password'}</span>
            </button>
            <span className="text-meta text-amber-300/70 font-mono truncate max-w-[140px]" title={vaultKey}>{vaultKey}</span>
            <button
              onClick={() => setDetectedPasswordPrompt(null)}
              className="p-0.5 text-slate-400 hover:text-white rounded"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {detectedPasswordPrompt && vault?.locked && vaultExists && (
          <div className="absolute top-3 right-14 z-30 flex items-center space-x-2 bg-plinky-900/95 border border-slate-600 text-slate-300 px-3 py-1.5 rounded-lg shadow-2xl text-xs">
            <Key className="w-3.5 h-3.5 text-slate-400" />
            <span>Password prompt. The vault is locked.</span>
            <button
              onClick={() => setUnlockOpen(true)}
              className="px-2 py-0.5 rounded border border-slate-500 text-slate-200 hover:bg-plinky-800"
            >
              Unlock…
            </button>
            <button onClick={() => setDetectedPasswordPrompt(null)} className="p-0.5 text-slate-400 hover:text-white rounded" title="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {unlockOpen && (
          <VaultUnlockDialog
            reason="This prompt's password is in the vault. Unlock it and Plinky can send it."
            onUnlocked={() => { setUnlockOpen(false); terminalRef.current?.focus(); }}
            onCancel={() => { setUnlockOpen(false); terminalRef.current?.focus(); }}
          />
        )}

        {/* Free Type Visual Click Indicator */}
        {clickIndicator && (
          <div
            className="free-type-cursor-indicator rounded"
            style={{
              transform: `translate(${clickIndicator.x - 12}px, ${clickIndicator.y - 8}px)`,
              width: '24px',
              height: '18px',
            }}
          />
        )}

        {/* Custom Terminal Context Menu */}
        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="fixed z-40 w-60 max-h-[calc(100vh-16px)] overflow-y-auto bg-plinky-900 border border-plinky-700/80 rounded-lg shadow-2xl py-1 text-slate-200 text-xs select-none backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={handleCopy}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Copy className="w-3.5 h-3.5 text-sky-400" />
              <span className="flex-1">Copy Selection</span>
              <span className="text-meta text-plinky-muted">Ctrl+Shift+C</span>
            </button>
            <button
              onClick={handleCopyAll}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <CopyCheck className="w-3.5 h-3.5 text-slate-400" />
              <span>Copy All to Clipboard</span>
            </button>
            <button
              onClick={handlePaste}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Clipboard className="w-3.5 h-3.5 text-slate-400" />
              <span className="flex-1">Paste Clipboard</span>
              <span className="text-meta text-plinky-muted">Ctrl+Shift+V</span>
            </button>
            <button
              onClick={handleSelectAll}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <CheckSquare className="w-3.5 h-3.5 text-slate-400" />
              <span className="flex-1">Select All</span>
              <span className="text-meta text-plinky-muted">Ctrl+Shift+A</span>
            </button>
            {vaultKey && (
              <>
                <div className="border-t border-plinky-800 my-1" />
                <div className="px-3 py-1 text-meta font-semibold uppercase tracking-wider text-plinky-muted flex items-center space-x-1">
                  <Shield className="w-3 h-3 text-slate-400" />
                  <span>Vault ({vaultKey})</span>
                </div>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    handleSendVaultPassword();
                  }}
                  disabled={!isVaultUnlocked}
                  className={`w-full flex items-center space-x-2 px-3 py-1.5 text-left transition ${
                    isVaultUnlocked ? 'hover:bg-sky-600/20 text-slate-200' : 'text-plinky-muted cursor-not-allowed'
                  }`}
                >
                  <Key className="w-3.5 h-3.5 text-slate-400" />
                  <span>Send Login Password</span>
                </button>
                {vault?.hasEnableSecret && (
                  <button
                    onClick={() => {
                      setContextMenu(null);
                      handleSendVaultEnablePassword();
                    }}
                    disabled={!isVaultUnlocked}
                    className={`w-full flex items-center space-x-2 px-3 py-1.5 text-left transition ${
                      isVaultUnlocked ? 'hover:bg-sky-600/20 text-slate-200' : 'text-plinky-muted cursor-not-allowed'
                    }`}
                  >
                    <Shield className="w-3.5 h-3.5 text-slate-400" />
                    <span>Send Enable Password</span>
                  </button>
                )}
              </>
            )}
            <div className="border-t border-plinky-800 my-1" />
            <button
              onClick={handleClearScrollback}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Trash2 className="w-3.5 h-3.5 text-slate-400" />
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
              <List className="w-3.5 h-3.5 text-slate-400" />
              <span>PuTTY Event Log...</span>
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                setIsLoggingOpen(true);
              }}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <FileText className="w-3.5 h-3.5 text-slate-400" />
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
                <Copy className="w-3.5 h-3.5 text-slate-400" />
                <span>Duplicate Session</span>
              </button>
            )}
            {isTauriEnvironment() && tab.status !== 'disconnected' && !runningScript && (
              <button
                onClick={() => { void handleRunScript(); }}
                className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
              >
                <FileCode className="w-3.5 h-3.5 text-slate-400" />
                <span>Run Script...</span>
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
            {tab.status === 'disconnected' && (
              <button
                onClick={() => { setContextMenu(null); handleManualReconnect(); }}
                className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
              >
                <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                <span>Reconnect</span>
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
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <span>Find in Terminal...</span>
            </button>
            {tab.protocol === 'Serial' && (
              <>
                <div className="border-t border-plinky-800 my-1" />
                <button
                  onClick={() => {
                    setContextMenu(null);
                    // A serial Break (held ~400 ms): Cisco ROMMON and similar
                    // password recovery need it during boot. Only a serial
                    // line can send one (ADR-005).
                    sendBreak(tab.id)
                      .then(() => addEventLog('Sent a serial Break', 'info'))
                      .catch(e => addEventLog(`Send Break failed: ${String(e)}`, 'error'));
                  }}
                  title="Hold a Break condition on the line for 400 ms (ROMMON / password recovery)"
                  className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
                >
                  <Zap className="w-3.5 h-3.5 text-slate-400" />
                  <span>Send Break</span>
                </button>
              </>
            )}
            {supportsShellHooks && (
              <>
                <div className="border-t border-plinky-800 my-1" />
                <div
                  className="px-3 pt-1 pb-0.5 flex items-center space-x-2 text-slate-400"
                  title="Optional. Teaches the remote Unix shell to report prompts and its current directory (SFTP folder-following, Ctrl+Up/Down prompt jumping). Not for network devices."
                >
                  <Zap className="w-3.5 h-3.5 text-slate-400" />
                  <span>
                    {hooksInjected ? `Shell hooks active (${hooksInjected})` : 'Shell hooks for:'}
                  </span>
                </div>
                {!hooksInjected && (
                  <div className="px-3 pb-1.5 flex items-center space-x-1">
                    {(['bash', 'zsh', 'fish'] as const).map(shell => (
                      <button
                        key={shell}
                        onClick={() => handleInjectHooks(shell)}
                        title={shell === lastHooksShell ? 'Last used for this session' : undefined}
                        className={`flex-1 py-0.5 rounded border font-mono text-meta transition ${
                          shell === lastHooksShell
                            ? 'border-sky-500/50 bg-sky-500/15 text-sky-200'
                            : 'border-plinky-700 text-slate-300 hover:bg-sky-600/30 hover:text-sky-200'
                        }`}
                      >
                        {shell}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
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
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-plinky-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-plinky-900 border border-plinky-700 rounded-xl shadow-2xl max-w-2xl w-full flex flex-col max-h-[80vh] overflow-hidden text-slate-100">
              <div className="px-4 py-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <List className="w-4 h-4 text-slate-400" />
                  <span className="font-semibold text-sm">Event Log: {tab.sessionName}</span>
                </div>
                <button aria-label="Close event log"
                  onClick={() => setIsEventLogOpen(false)}
                  className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 bg-slate-950/90 font-mono text-meta space-y-1 select-text">
                {eventLogs.length === 0 ? (
                  <div className="text-plinky-muted italic">No events logged yet.</div>
                ) : (
                  eventLogs.map((log) => (
                    <div key={log.id} className="flex space-x-2 leading-relaxed">
                      <span className="text-plinky-muted select-none">[{log.time}]</span>
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
                    void writeClipboard(text);
                    addEventLog("Event log copied to clipboard", 'info');
                  }}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
                >
                  <CopyCheck className="w-3.5 h-3.5 text-slate-400" />
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
                    className="px-4 py-1.5 rounded bg-sky-700 hover:brightness-110 text-on-accent text-xs font-medium transition"
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
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-plinky-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-plinky-900 border border-plinky-700 rounded-xl shadow-2xl max-w-md w-full flex flex-col overflow-hidden text-slate-100">
              <div className="px-4 py-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <FileText className="w-4 h-4 text-slate-400" />
                  <span className="font-semibold text-sm">Session Log</span>
                </div>
                <button aria-label="Close logging"
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
                    <span className={`h-2.5 w-2.5 rounded-full ${isLogging ? 'bg-rose-500' : 'bg-slate-600'}`}></span>
                    <span className="font-semibold text-slate-200">
                      {isLogging ? 'Logging is ACTIVE' : 'Logging is STOPPED'}
                    </span>
                  </div>
                  <span className="font-mono text-slate-400">
                    {(loggedBytes / 1024).toFixed(1)} KB logged
                  </span>
                </div>

                <p className="text-slate-400">
                  Saves what you see on screen as plain text, without colour or cursor codes.
                </p>

                {logPath && (
                  <div className="space-y-1">
                    <label className="text-slate-400 font-medium">Saving to</label>
                    <div className="flex items-center space-x-2">
                      <code className="flex-1 min-w-0 truncate p-1.5 rounded bg-plinky-950 border border-plinky-800 text-slate-300 font-mono text-meta" title={logPath}>
                        {logPath}
                      </code>
                      <button
                        onClick={() => void writeClipboard(logPath)}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                      >
                        Copy path
                      </button>
                    </div>
                  </div>
                )}
                {logError && (
                  <div role="alert" className="p-2 rounded border border-rose-500/40 bg-rose-950/40 text-rose-300 text-meta">
                    {logError}
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between pt-2 border-t border-plinky-800">
                  <button
                    onClick={async () => {
                      setLogError(null);
                      try {
                        if (isLogging) {
                          await stopSessionLog(tab.id);
                          setIsLogging(false);
                          addEventLog(`Session logging stopped (${logPath ?? 'log'})`, 'info');
                          return;
                        }
                        // Plain text only: colour codes read as [01;34m...[0m in an editor.
                        const info = await startSessionLog(tab.id, tab.sessionName, 'printable');
                        if (!info) return; // dialog cancelled
                        setIsLogging(true);
                        setLogPath(info.path);
                        setLoggedBytes(info.bytes);
                        addEventLog(`Session logging to ${info.path}`, 'success');
                      } catch (err) {
                        // Not started: no live session yet, or the file couldn't be opened.
                        setLogError(String(err));
                      }
                    }}
                    className={`px-3 py-1.5 rounded font-medium transition ${
                      isLogging
                        ? 'bg-rose-600 hover:bg-rose-500 text-on-danger'
                        : 'bg-sky-700 hover:brightness-110 text-on-accent'
                    }`}
                  >
                    {isLogging ? 'Stop Logging' : 'Start Logging…'}
                  </button>
                  <span className="text-plinky-muted text-meta">
                    {isLogging ? 'Written to disk as it arrives.' : 'Asks where to save, then writes as output arrives.'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Host key dialog. A changed key is the moment a man-in-the-middle
            shows up, and plink itself says Return (abandon) is the only
            guaranteed safe choice; so it gets a red frame, Abandon focused,
            and accepting reads as the destructive action it is. */}
        {pendingPrompt && (
          <HostKeyDialog prompt={pendingPrompt} onAnswer={handleAnswerPrompt} />
        )}
      </div>
    </div>
  );
};

export const HostKeyDialog: React.FC<{
  prompt: HostKeyPromptInfo;
  onAnswer: (answer: 'reject' | 'once' | 'store') => void;
}> = ({ prompt, onAnswer }) => {
  const changed = !!prompt.changed;
  const abandonRef = useRef<HTMLButtonElement>(null);
  // The fingerprint PuTTY saved, beside the one offered now: comparing the
  // two is the whole decision, and only the new one was shown.
  const [stored, setStored] = useState<string | null>(null);
  useEffect(() => {
    if (!changed) return;
    let live = true;
    void storedFingerprint(prompt).then(fp => { if (live) setStored(fp); });
    return () => { live = false; };
  }, [changed, prompt]);
  // The parent re-renders on every chunk of output; a fresh onAnswer each
  // time must not re-run the effect and yank focus back to Abandon.
  const answerRef = useRef(onAnswer);
  answerRef.current = onAnswer;
  useEffect(() => {
    abandonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        answerRef.current('reject');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (prompt.question) {
    // A question plink asked that Plinky has no dialog of its own for.
    return (
      <div className="absolute inset-0 z-50 flex items-center justify-center bg-plinky-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div role="alertdialog" aria-modal="true" aria-labelledby="question-title"
          className="bg-plinky-900 border border-amber-500/60 rounded-xl shadow-2xl max-w-lg w-full p-6 text-slate-100">
          <h3 id="question-title" className="text-base font-semibold text-white mb-2">PuTTY is asking</h3>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-slate-200 bg-plinky-950/80 border border-plinky-800 rounded-lg p-3 mb-5">{prompt.question}</pre>
          <div className="flex gap-2 justify-end">
            <button ref={abandonRef} onClick={() => onAnswer('reject')}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-plinky-800 hover:bg-plinky-700 text-slate-200 outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-plinky-900 focus:ring-sky-400">
              No
            </button>
            <button onClick={() => onAnswer('once')}
              className="px-3 py-2 rounded-lg bg-sky-700 hover:brightness-110 text-on-accent text-xs font-medium">
              Yes
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (prompt.weak) {
    // plink's weak-crypto question, before any host key. It used to land in
    // the terminal as plain text; the answer had to be typed.
    const [what, alg] = prompt.weak.split(': ');
    return (
      <div className="absolute inset-0 z-50 flex items-center justify-center bg-plinky-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="weakcrypto-title"
          aria-describedby="weakcrypto-desc"
          className="bg-plinky-900 border border-amber-500/60 rounded-xl shadow-2xl max-w-lg w-full p-6 text-slate-100"
        >
          <div className="flex items-start space-x-3 mb-4">
            <div className="p-2.5 rounded-lg border bg-amber-500/10 border-amber-500/30 text-amber-400">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div>
              <h3 id="weakcrypto-title" className="text-base font-semibold text-white">This server only offers outdated encryption</h3>
              <p id="weakcrypto-desc" className="text-xs text-slate-300 mt-1 leading-relaxed">
                Its first {what || 'algorithm'} is <span className="font-mono text-amber-300">{alg || prompt.weak}</span>,
                which PuTTY rates below its warning threshold. Older network gear often only has this; the
                connection works, but is easier to break than a modern one.
              </p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 justify-end">
            <button
              ref={abandonRef}
              onClick={() => onAnswer('reject')}
              className="order-first px-3 py-2 rounded-lg text-xs font-semibold bg-plinky-800 hover:bg-plinky-700 text-slate-200 outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-plinky-900 focus:ring-sky-400"
            >
              Abandon connection
            </button>
            <button
              onClick={() => onAnswer('once')}
              className="px-3 py-2 rounded-lg bg-sky-700 hover:brightness-110 text-on-accent text-xs font-medium transition-colors"
            >
              Connect anyway
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-plinky-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="hostkey-title"
        aria-describedby="hostkey-desc"
        className={`bg-plinky-900 border rounded-xl shadow-2xl max-w-lg w-full p-6 text-slate-100 ${
          changed ? 'border-rose-500/80 ring-1 ring-rose-500/40' : 'border-amber-500/60'
        }`}
      >
        <div className="flex items-start space-x-3 mb-4">
          <div className={`p-2.5 rounded-lg border ${
            changed ? 'bg-rose-500/15 border-rose-500/40 text-rose-400' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
          }`}>
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div>
            <h3 id="hostkey-title" className="text-base font-semibold text-white">
              {changed ? 'This server\'s host key has changed' : 'New host: check its key'}
            </h3>
            <p id="hostkey-desc" className="text-xs text-slate-300 mt-1 leading-relaxed">
              {changed ? (
                <>
                  The key {prompt.host || 'this server'} offered does not match the one PuTTY saved on an earlier visit.
                  Either an administrator replaced it, or something is intercepting the connection.{' '}
                  <strong className="text-rose-300">Abandon unless you were told the key changed</strong>, and
                  compare the fingerprint with the administrator first.
                </>
              ) : (
                <>PuTTY has never connected to this server before, so it cannot vouch for it. Compare the fingerprint with one you trust before storing it.</>
              )}
            </p>
          </div>
        </div>

        <div className="space-y-2 bg-plinky-950/80 rounded-lg p-3 border border-plinky-800 text-xs mb-5">
          <div className="flex justify-between gap-3">
            <span className="text-slate-400">Destination</span>
            <span className="font-mono text-slate-200 font-semibold">{prompt.host}:{prompt.port}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-400">Key type</span>
            <span className="font-mono text-slate-200">{prompt.key_type}</span>
          </div>
          <div>
            <span className="text-slate-400 block mb-1">{changed ? 'Offered now' : 'Fingerprint'}</span>
            <span className={`font-mono break-all select-all font-semibold ${changed ? 'text-rose-200' : 'text-slate-100'}`}>
              {prompt.fingerprint}
            </span>
          </div>
          {changed && (
            <div>
              <span className="text-slate-400 block mb-1">Saved by PuTTY earlier</span>
              <span className="font-mono break-all select-all text-slate-300">
                {stored ?? 'Not found in PuTTY\u2019s store'}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-2 justify-end">
          {changed ? (
            <>
              <button
                onClick={() => onAnswer('store')}
                className="px-3 py-2 rounded-lg border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 text-xs font-medium transition-colors"
              >
                I expected this: replace the key
              </button>
              <button
                onClick={() => onAnswer('once')}
                className="px-3 py-2 rounded-lg border border-plinky-700 text-slate-300 hover:bg-plinky-800 text-xs font-medium transition-colors"
              >
                Connect once, keep the old key
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onAnswer('once')}
                className="px-3 py-2 rounded-lg border border-plinky-700 text-slate-300 hover:bg-plinky-800 text-xs font-medium transition-colors"
              >
                Connect once
              </button>
              <button
                onClick={() => onAnswer('store')}
                className="px-3 py-2 rounded-lg bg-sky-700 hover:brightness-110 text-on-accent text-xs font-medium transition-colors"
              >
                Trust and store key
              </button>
            </>
          )}
          <button
            ref={abandonRef}
            onClick={() => onAnswer('reject')}
            className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-plinky-900 ${
              changed
                ? 'order-first sm:order-last bg-rose-700 hover:brightness-110 text-on-danger focus:ring-rose-300'
                : 'order-first bg-plinky-800 hover:bg-plinky-700 text-slate-200 focus:ring-sky-400'
            }`}
          >
            Abandon connection
          </button>
        </div>
      </div>
    </div>
  );
};

/** The fingerprint PuTTY has saved for this prompt's host, port and key
 *  type; the prompt names the type as the server does ("ssh-rsa"), the
 *  cache as PuTTY does ("rsa2"). */
export async function storedFingerprint(prompt: HostKeyPromptInfo): Promise<string | null> {
  const cacheType = ({ 'ssh-rsa': 'rsa2', 'ssh-dss': 'dss' } as Record<string, string>)[prompt.key_type] ?? prompt.key_type;
  try {
    const keys = await listPuttyHostKeys();
    return keys.find(k => k.hostname === prompt.host && k.port === prompt.port && k.keyType === cacheType)?.fingerprint ?? null;
  } catch {
    return null;
  }
}
