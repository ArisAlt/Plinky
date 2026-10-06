import React, { useState, useEffect } from 'react';
import { Settings, X, Type, Shield, Monitor, RotateCcw, Check, MousePointer, Trash2, AlertTriangle, Keyboard, FileCode } from 'lucide-react';
import { UI_THEMES, applyUiTheme, useUiTheme } from '../../themes/uiThemes';
import { TERMINAL_THEMES, MATCH_INTERFACE, setTerminalTheme, useTerminalTheme } from '../../themes/terminalThemes';
import { TERMINAL_FONTS } from '../../themes/fonts';
import { TERMINAL_FONT_MIN, TERMINAL_FONT_MAX } from '../../services/terminalFontKeys';
import { useUiZoom, zoomIn, zoomOut, zoomReset, UI_ZOOM_MIN, UI_ZOOM_MAX } from '../../services/uiZoom';
import { detectPutty, PuttyDetectInfo, vaultIsInitialized, vaultDestroy } from '../../services/tauriBridge';
import { usePasteConfirmMode, setPasteConfirmMode, PasteConfirmMode } from '../../services/pasteConfirm';
import { SHORTCUT_LIST } from '../../services/shortcuts';
import { SCROLLBACK_CHOICES, DEFAULT_SCROLLBACK, setScrollback, useScrollback } from '../../services/scrollback';

const PASTE_OPTIONS: { mode: PasteConfirmMode; label: string; hint: string }[] = [
  { mode: 'multiline', label: 'Multi-line pastes', hint: 'Asks before pasting several lines' },
  { mode: 'always', label: 'Every paste', hint: 'Asks before any paste' },
  { mode: 'never', label: 'Never', hint: 'Pastes straight away' },
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  fontFamily: string;
  onChangeFontFamily: (font: string) => void;
  fontSize: number;
  onChangeFontSize: (size: number) => void;
  cursorStyle: 'block' | 'bar' | 'underline';
  onChangeCursorStyle: (style: 'block' | 'bar' | 'underline') => void;
  copyOnSelect?: boolean;
  onChangeCopyOnSelect?: (val: boolean) => void;
  rightClickAction?: 'paste' | 'contextMenu';
  onChangeRightClickAction?: (action: 'paste' | 'contextMenu') => void;
  onResetLayout: () => void;
}


export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  fontFamily,
  onChangeFontFamily,
  fontSize,
  onChangeFontSize,
  cursorStyle,
  onChangeCursorStyle,
  copyOnSelect = true,
  onChangeCopyOnSelect,
  rightClickAction = 'contextMenu',
  onChangeRightClickAction,
  onResetLayout,
}) => {
  const uiZoom = useUiZoom();
  const pasteMode = usePasteConfirmMode();
  const uiTheme = useUiTheme();
  const termTheme = useTerminalTheme();
  const scrollback = useScrollback();
  const knownFont = TERMINAL_FONTS.some(f => f.value === fontFamily);
  const [puttyInfo, setPuttyInfo] = useState<PuttyDetectInfo | null>(null);
  const [resetDone, setResetDone] = useState(false);
  // Delete vault: two warnings, then delete.
  const [vaultExists, setVaultExists] = useState(false);
  const [deleteStep, setDeleteStep] = useState<'idle' | 'warn1' | 'warn2' | 'deleting'>('idle');
  const [deleteResult, setDeleteResult] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      detectPutty().then(setPuttyInfo);
      setResetDone(false);
      setDeleteStep('idle');
      setDeleteResult(null);
      vaultIsInitialized().then(setVaultExists).catch(() => setVaultExists(false));
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleDeleteVault = async () => {
    setDeleteStep('deleting');
    try {
      const deleted = await vaultDestroy();
      setDeleteResult(deleted ? 'Vault deleted. Open Vault to create a new one.' : 'There was no vault to delete.');
      setVaultExists(false);
    } catch (e) {
      setDeleteResult(String(e));
    } finally {
      setDeleteStep('idle');
    }
  };

  const handleResetLayout = () => {
    onResetLayout();
    setResetDone(true);
    setTimeout(() => setResetDone(false), 2000);
  };

  return (
    <div 
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 bg-plinky-950/75 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none"
    >
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="bg-plinky-900 border border-plinky-700 rounded-lg w-[580px] max-w-full shadow-2xl flex flex-col overflow-hidden text-xs text-slate-200">
        {/* Header */}
        <div className="p-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Settings className="w-4 h-4 text-sky-400" />
            <h3 id="settings-title" className="font-semibold text-slate-100 text-base">Settings</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-5 overflow-y-auto max-h-[75vh]">
          {/* Section: Interface theme */}
          <div className="space-y-2">
            <div className="text-slate-300 font-semibold">Interface theme</div>
            <div role="radiogroup" aria-label="Interface theme" className="grid grid-cols-3 gap-2">
              {UI_THEMES.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={uiTheme === t.id}
                  onClick={() => applyUiTheme(t.id)}
                  className={`flex items-center gap-2 p-1.5 rounded border text-left transition ${
                    uiTheme === t.id ? 'border-sky-500 bg-sky-500/10 text-slate-100' : 'border-plinky-700 hover:border-plinky-600 text-slate-300'
                  }`}
                >
                  <span className="flex h-6 w-9 shrink-0 overflow-hidden rounded border border-black/20" aria-hidden>
                    <span className="flex-1" style={{ background: t.swatch[0] }} />
                    <span className="flex-1" style={{ background: t.swatch[1] }} />
                    <span className="flex-1" style={{ background: t.swatch[2] }} />
                    <span className="flex-1" style={{ background: t.swatch[3] }} />
                  </span>
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Section: Interface size */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-slate-300 font-semibold">Interface size</div>
                <div className="text-meta text-plinky-muted">Sessions, tabs and dialogs. Set here only.</div>
              </div>
              <div className="flex items-center gap-1" role="group" aria-label="Interface size">
                <button type="button" onClick={zoomOut} disabled={uiZoom <= UI_ZOOM_MIN} aria-label="Smaller interface"
                  className="w-7 h-7 rounded border border-plinky-700 bg-plinky-950 text-slate-200 hover:border-sky-500 disabled:opacity-40">−</button>
                <span className="w-12 text-center tabular-nums text-slate-200" aria-live="polite">{Math.round(uiZoom * 100)}%</span>
                <button type="button" onClick={zoomIn} disabled={uiZoom >= UI_ZOOM_MAX} aria-label="Larger interface"
                  className="w-7 h-7 rounded border border-plinky-700 bg-plinky-950 text-slate-200 hover:border-sky-500 disabled:opacity-40">+</button>
                <button type="button" onClick={zoomReset} disabled={uiZoom === 1}
                  className="ml-1 px-2 h-7 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 disabled:opacity-40">Reset</button>
              </div>
            </div>
          </div>

          {/* Section: Terminal Appearance */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <Type className="w-3.5 h-3.5 text-sky-400" />
              <span>Terminal</span>
            </div>
            <p className="text-meta text-plinky-muted">
              The default for every session. A saved session can have its own colour scheme and font: right-click it,
              Change Session Settings, Appearance.
            </p>

            {/* Colour scheme + live preview */}
            <div className="space-y-1">
              <label htmlFor="settings-terminal-scheme" className="text-meta text-slate-400 font-medium">Colour scheme</label>
              <select
                id="settings-terminal-scheme"
                value={termTheme.id}
                onChange={(e) => setTerminalTheme(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-plinky-950 border border-plinky-700 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500 transition"
              >
                <option value={MATCH_INTERFACE}>Match interface theme</option>
                {TERMINAL_THEMES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div
              data-testid="terminal-preview"
              aria-label={`Preview of ${termTheme.name}`}
              className="rounded border border-plinky-700 px-3 py-2 overflow-hidden select-none"
              style={{
                background: termTheme.theme.background,
                color: termTheme.theme.foreground,
                fontFamily,
                fontSize: `${fontSize}px`,
                lineHeight: 1.25,
              }}
            >
              <div className="whitespace-pre">
                <span style={{ color: termTheme.theme.green }}>admin@core-sw1</span>
                <span>:</span>
                <span style={{ color: termTheme.theme.blue }}>~</span>
                <span>$ show ip int brief</span>
              </div>
              <div className="whitespace-pre">
                <span>Gi0/1  10.0.0.1  </span>
                <span style={{ color: termTheme.theme.green }}>up</span>
                <span>    Gi0/2  </span>
                <span style={{ color: termTheme.theme.red }}>down</span>
                <span style={{ color: termTheme.theme.yellow }}>  warn</span>
              </div>
              <div className="flex gap-1 pt-1.5" aria-hidden>
                {(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const).map(k => (
                  <span key={k} className="flex-1 h-2.5 rounded-sm" style={{ background: termTheme.theme[k] }} />
                ))}
              </div>
              <div className="flex gap-1 pt-1" aria-hidden>
                {(['brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const).map(k => (
                  <span key={k} className="flex-1 h-2.5 rounded-sm" style={{ background: termTheme.theme[k] }} />
                ))}
              </div>
            </div>

            {/* Font Family */}
            <div className="space-y-1">
              <label htmlFor="settings-modal-font-family" className="text-meta text-slate-400 font-medium">Font Family</label>
              <select id="settings-modal-font-family"
                value={fontFamily}
                onChange={(e) => onChangeFontFamily(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-plinky-950 border border-plinky-700 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500 transition"
              >
                {!knownFont && <option value={fontFamily}>Custom (saved)</option>}
                <optgroup label="Built in">
                  {TERMINAL_FONTS.filter(f => f.bundled).map(f => (
                    <option key={f.value} value={f.value}>{f.label}{f.note ? ` (${f.note})` : ''}</option>
                  ))}
                </optgroup>
                <optgroup label="If installed">
                  {TERMINAL_FONTS.filter(f => !f.bundled).map(f => (
                    <option key={f.value} value={f.value}>{f.label}{f.note ? ` (${f.note})` : ''}</option>
                  ))}
                </optgroup>
              </select>
            </div>

            {/* Font Size & Cursor Style */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="settings-modal-font-size-px" className="text-meta text-slate-400 font-medium" title="Ctrl+Shift+= / Ctrl+Shift+- · Ctrl+Shift+0 resets">Font Size ({fontSize}px)</label>
                <input id="settings-modal-font-size-px"
                  type="range"
                  min={TERMINAL_FONT_MIN}
                  max={TERMINAL_FONT_MAX}
                  step="1"
                  value={fontSize}
                  onChange={(e) => onChangeFontSize(parseInt(e.target.value, 10))}
                  className="w-full accent-sky-500 cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <label className="text-meta text-slate-400 font-medium">Cursor Style</label>
                <div className="flex space-x-1">
                  {(['block', 'bar', 'underline'] as const).map(style => (
                    <button
                      key={style}
                      type="button"
                      onClick={() => onChangeCursorStyle(style)}
                      className={`flex-1 py-1 rounded text-center capitalize transition border ${
                        cursorStyle === style
                          ? 'bg-sky-500/20 border-sky-500/50 text-sky-300 font-medium'
                          : 'bg-plinky-950 border-plinky-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Scrollback (scrollback.ts) */}
            <div className="space-y-1">
              <label htmlFor="settings-scrollback" className="text-meta text-slate-400 font-medium">Scrollback</label>
              <select
                id="settings-scrollback"
                value={scrollback}
                onChange={(e) => setScrollback(Number(e.target.value))}
                className="w-full bg-plinky-950 border border-plinky-800 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
              >
                {SCROLLBACK_CHOICES.map(n => (
                  <option key={n} value={n}>
                    {n.toLocaleString('en-US')} lines{n === 2000 ? ' (PuTTY)' : n === DEFAULT_SCROLLBACK ? ' (default)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-meta text-plinky-muted">
                Lines kept above the screen, for scrolling back and Copy All to Clipboard. More lines use more memory in every open tab.
              </p>
            </div>
          </div>

          {/* Section: PuTTY Mouse & Clipboard */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <MousePointer className="w-3.5 h-3.5 text-slate-400" />
              <span>PuTTY Mouse & Clipboard Behavior</span>
            </div>

            <div className="space-y-3 p-3 bg-plinky-950 rounded border border-plinky-800">
              {/* Copy on select */}
              <label className="flex items-start space-x-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={copyOnSelect}
                  onChange={(e) => onChangeCopyOnSelect?.(e.target.checked)}
                  className="mt-0.5 rounded border-plinky-700 bg-plinky-900 text-sky-500 focus:ring-0 cursor-pointer"
                />
                <div className="select-none">
                  <span className="text-slate-200 font-medium block">Copy on select (Classic PuTTY)</span>
                  <span className="text-meta text-plinky-muted block">Selecting text with the mouse copies it to the clipboard straight away, no shortcut needed.</span>
                </div>
              </label>

              {/* Right-click action */}
              <div className="space-y-1.5 pt-2 border-t border-plinky-800/80">
                <label className="text-meta text-slate-400 font-medium block">Right-Click Action</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => onChangeRightClickAction?.('contextMenu')}
                    className={`py-1.5 px-2 rounded text-left transition border ${
                      rightClickAction === 'contextMenu'
                        ? 'bg-sky-500/20 border-sky-500/50 text-sky-300 font-medium'
                        : 'bg-plinky-900 border-plinky-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="font-semibold text-meta">Context Menu</div>
                    <div className="text-meta text-slate-400">Show PuTTY action menu</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => onChangeRightClickAction?.('paste')}
                    className={`py-1.5 px-2 rounded text-left transition border ${
                      rightClickAction === 'paste'
                        ? 'bg-sky-500/20 border-sky-500/50 text-sky-300 font-medium'
                        : 'bg-plinky-900 border-plinky-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="font-semibold text-meta">Paste Clipboard (PuTTY)</div>
                    <div className="text-meta text-slate-400">Right click pastes (Shift+Right for menu)</div>
                  </button>
                </div>
              </div>

              {/* Paste window (pasteConfirm.ts) */}
              <div className="space-y-1.5 pt-2 border-t border-plinky-800/80">
                <label className="text-meta text-slate-400 font-medium block">Show the paste window</label>
                <div className="grid grid-cols-3 gap-2">
                  {PASTE_OPTIONS.map(o => (
                    <button
                      key={o.mode}
                      type="button"
                      onClick={() => setPasteConfirmMode(o.mode)}
                      aria-pressed={pasteMode === o.mode}
                      className={`py-1.5 px-2 rounded text-left transition border ${
                        pasteMode === o.mode
                          ? 'bg-sky-500/20 border-sky-500/50 text-sky-300 font-medium'
                          : 'bg-plinky-900 border-plinky-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <div className="font-semibold text-meta">{o.label}</div>
                      <div className="text-meta text-slate-400">{o.hint}</div>
                    </button>
                  ))}
                </div>
                <p className="text-meta text-plinky-muted">Shows the text before it is sent, so you can check or edit it.</p>
              </div>
            </div>
          </div>

          {/* Section: Keyboard shortcuts (shortcuts.ts) */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <Keyboard className="w-3.5 h-3.5 text-slate-400" />
              <span>Keyboard Shortcuts</span>
            </div>
            <dl className="p-3 bg-plinky-950 rounded border border-plinky-800 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              {SHORTCUT_LIST.map(s => (
                <React.Fragment key={s.action}>
                  <dt className="flex flex-wrap gap-1">
                    {s.keys.map(k => (
                      <kbd key={k} className="px-1.5 py-0.5 rounded bg-plinky-900 border border-plinky-700 font-mono text-meta text-slate-200 whitespace-nowrap">{k}</kbd>
                    ))}
                  </dt>
                  <dd className="text-meta text-slate-300 self-center">{s.action}</dd>
                </React.Fragment>
              ))}
            </dl>
            <p className="text-meta text-plinky-muted">Ctrl+C and Ctrl+V go to the device, as in PuTTY.</p>
          </div>

          {/* Section: Scripts (src-tauri/src/scripts.rs, scripting/plinky.py) */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <FileCode className="w-3.5 h-3.5 text-slate-400" />
              <span>Scripts</span>
            </div>
            <div className="p-3 bg-plinky-950 rounded border border-plinky-800 space-y-2 text-meta text-slate-300 leading-relaxed">
              <p>
                Right-click a terminal and choose <strong>Run Script...</strong> to run a script on that session.
                What the script prints is typed into the session, and what the device prints is the script's input.
                Anything it writes to stderr shows in the terminal as a note and is not sent. <strong>Stop</strong> ends it.
              </p>
              <p>
                Python (<code>.py</code>) runs with <code>python3</code> (<code>python</code> on Windows); <code>.sh</code> with bash,
                {' '}<code>.ps1</code> with PowerShell, <code>.bat</code>/<code>.cmd</code> with cmd; anything else as a program.
              </p>
              <pre className="p-2 rounded bg-plinky-900 border border-plinky-800 font-mono text-slate-200 overflow-x-auto">{`from plinky import session

session.send("terminal length 0")
session.wait_for_prompt()
config = session.command("show running-config")
open("backup.txt", "w").write(config)
session.log("saved", len(config), "characters")`}</pre>
              <p>
                <code>send(text)</code> types a line; <code>expect(regex)</code> waits for output;
                {' '}<code>wait_for_prompt()</code> waits for <code>#</code>, <code>&gt;</code> or <code>$</code>;
                {' '}<code>command(cmd)</code> returns a command's output; <code>log(...)</code> writes a note.
                Scripts never see the vault.
              </p>
            </div>
          </div>

          {/* Section: PuTTY Environment */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <Shield className="w-3.5 h-3.5 text-slate-400" />
              <span>PuTTY Discovery & Toolchain</span>
            </div>

            <div className="p-3 bg-plinky-950 rounded border border-plinky-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Binary Path:</span>
                <span className="font-mono text-slate-200">{puttyInfo?.path || '/usr/bin/plink'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Version:</span>
                <span className="font-mono text-slate-200">v{puttyInfo?.version || '0.85'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Status:</span>
                <span className="flex items-center space-x-1 text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                  <span>{puttyInfo?.ok ? 'Ready & Validated' : 'Detection Pending'}</span>
                </span>
              </div>
            </div>
          </div>

          {/* Section: Workbench Layout & State */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <Monitor className="w-3.5 h-3.5 text-slate-400" />
              <span>Workbench Layout & Cache</span>
            </div>

            <div className="flex items-center justify-between p-2.5 bg-plinky-950 rounded border border-plinky-800">
              <div>
                <p className="font-medium text-slate-200">Reset Saved Layout</p>
                <p className="text-meta text-plinky-muted">Clears cached split panes, tab order, and restores default single layout.</p>
              </div>
              <button
                type="button"
                onClick={handleResetLayout}
                className="shrink-0 whitespace-nowrap flex items-center space-x-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
              >
                {resetDone ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400 font-medium">Reset!</span>
                  </>
                ) : (
                  <>
                    <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                    <span>Reset Layout</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Section: Credential Vault */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <Shield className="w-3.5 h-3.5 text-slate-400" />
              <span>Credential Vault</span>
            </div>

            <div className="p-2.5 bg-plinky-950 rounded border border-plinky-800 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-200">Delete Vault</p>
                  <p className="text-meta text-plinky-muted">
                    {vaultExists
                      ? 'Permanently deletes the vault and every password saved in it.'
                      : 'There is no vault yet, so there is nothing to delete.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setDeleteResult(null); setDeleteStep('warn1'); }}
                  disabled={!vaultExists || deleteStep !== 'idle'}
                  title={vaultExists ? 'Delete the vault' : 'There is no vault'}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-rose-950/40 border border-rose-800/50 hover:bg-rose-900/50 text-rose-300 disabled:opacity-40 disabled:pointer-events-none transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Vault</span>
                </button>
              </div>

              {deleteStep === 'warn1' && (
                <div role="alertdialog" aria-label="First warning" className="p-2.5 rounded border border-amber-600/50 bg-amber-950/30 space-y-2">
                  <p className="flex items-start space-x-1.5 text-amber-200">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                    <span>
                      Delete the vault? Every saved password and enable password in it will be deleted from this
                      computer. Your sessions stay, but they will ask for passwords again.
                    </span>
                  </p>
                  <div className="flex justify-end space-x-2">
                    <button type="button" onClick={() => setDeleteStep('idle')} className="px-3 py-1 rounded bg-plinky-800 hover:bg-plinky-700">Cancel</button>
                    <button type="button" onClick={() => setDeleteStep('warn2')} className="px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-on-warn">Yes, continue</button>
                  </div>
                </div>
              )}

              {(deleteStep === 'warn2' || deleteStep === 'deleting') && (
                <div role="alertdialog" aria-label="Final warning" className="p-2.5 rounded border border-rose-600/60 bg-rose-950/40 space-y-2">
                  <p className="flex items-start space-x-1.5 text-rose-200">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                    <span>
                      Last warning: this can't be undone. If you might need these passwords, cancel and use
                      Vault → Export to KeePass first.
                    </span>
                  </p>
                  <div className="flex justify-end space-x-2">
                    <button type="button" onClick={() => setDeleteStep('idle')} disabled={deleteStep === 'deleting'} className="px-3 py-1 rounded bg-plinky-800 hover:bg-plinky-700 disabled:opacity-40">Cancel</button>
                    <button type="button" onClick={handleDeleteVault} disabled={deleteStep === 'deleting'} className="px-3 py-1 rounded bg-rose-700 hover:bg-rose-600 text-on-danger font-medium disabled:opacity-40">
                      {deleteStep === 'deleting' ? 'Deleting…' : 'Delete vault permanently'}
                    </button>
                  </div>
                </div>
              )}

              {deleteResult && <p role="status" className="text-meta text-slate-300">{deleteResult}</p>}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 bg-plinky-950 border-t border-plinky-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-sky-700 hover:brightness-110 text-on-accent font-medium transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
