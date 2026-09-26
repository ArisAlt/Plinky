import React, { useState, useEffect } from 'react';
import { Settings, X, Type, Shield, Monitor, RotateCcw, Check, MousePointer, Trash2, AlertTriangle } from 'lucide-react';
import { detectPutty, PuttyDetectInfo, vaultIsInitialized, vaultDestroy } from '../../services/tauriBridge';

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

const AVAILABLE_FONTS = [
  { label: 'MesloLGS Nerd Font (Recommended for Powerlevel10k / Starship)', value: '"MesloLGS Nerd Font", "MesloLGS NF", monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", "JetBrainsMono Nerd Font", monospace' },
  { label: 'Fira Code', value: '"Fira Code", "FiraCode Nerd Font", monospace' },
  { label: 'FantasqueSansM Nerd Font', value: '"FantasqueSansM Nerd Font", monospace' },
  { label: 'DejaVu Sans Mono', value: '"DejaVu Sans Mono", monospace' },
  { label: 'System Monospace', value: 'monospace' },
];

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
  const [puttyInfo, setPuttyInfo] = useState<PuttyDetectInfo | null>(null);
  const [resetDone, setResetDone] = useState(false);
  // Delete vault: two warnings, then delete (owner request).
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
      className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none"
    >
      <div className="bg-plinky-900 border border-plinky-700 rounded-lg w-[520px] shadow-2xl flex flex-col overflow-hidden text-xs text-slate-200">
        {/* Header */}
        <div className="p-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Settings className="w-4 h-4 text-sky-400" />
            <h3 className="font-semibold text-slate-100 text-sm">Plinky Settings</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-5 overflow-y-auto max-h-[75vh]">
          {/* Section: Terminal Appearance */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <Type className="w-3.5 h-3.5 text-sky-400" />
              <span>Terminal Typography & Cursor</span>
            </div>

            {/* Font Family */}
            <div className="space-y-1">
              <label className="text-[11px] text-slate-400 font-medium">Font Family</label>
              <select
                value={fontFamily}
                onChange={(e) => onChangeFontFamily(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-plinky-950 border border-plinky-700 rounded text-xs text-slate-200 focus:outline-none focus:border-sky-500 transition"
              >
                {AVAILABLE_FONTS.map(f => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>

            {/* Font Size & Cursor Style */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] text-slate-400 font-medium">Font Size ({fontSize}px)</label>
                <input
                  type="range"
                  min="10"
                  max="20"
                  step="1"
                  value={fontSize}
                  onChange={(e) => onChangeFontSize(parseInt(e.target.value, 10))}
                  className="w-full accent-sky-500 cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-slate-400 font-medium">Cursor Style</label>
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
          </div>

          {/* Section: PuTTY Mouse & Clipboard */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <MousePointer className="w-3.5 h-3.5 text-amber-400" />
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
                  <span className="text-[11px] text-slate-500 block">Selecting text with the mouse immediately copies it to the system clipboard without pressing Ctrl+C.</span>
                </div>
              </label>

              {/* Right-click action */}
              <div className="space-y-1.5 pt-2 border-t border-plinky-800/80">
                <label className="text-[11px] text-slate-400 font-medium block">Right-Click Action</label>
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
                    <div className="font-semibold text-[11px]">Context Menu</div>
                    <div className="text-[10px] text-slate-500">Show PuTTY action menu</div>
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
                    <div className="font-semibold text-[11px]">Paste Clipboard (PuTTY)</div>
                    <div className="text-[10px] text-slate-500">Right click pastes (Shift+Right for menu)</div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Section: PuTTY Environment */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
              <Shield className="w-3.5 h-3.5 text-emerald-400" />
              <span>PuTTY Discovery & Toolchain</span>
            </div>

            <div className="p-3 bg-plinky-950 rounded border border-plinky-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Binary Path:</span>
                <span className="font-mono text-slate-200">{puttyInfo?.path || '/usr/bin/plink'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Version:</span>
                <span className="font-mono text-emerald-400">v{puttyInfo?.version || '0.85'}</span>
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
              <Monitor className="w-3.5 h-3.5 text-purple-400" />
              <span>Workbench Layout & Cache</span>
            </div>

            <div className="flex items-center justify-between p-2.5 bg-plinky-950 rounded border border-plinky-800">
              <div>
                <p className="font-medium text-slate-200">Reset Saved Layout</p>
                <p className="text-[11px] text-slate-500">Clears cached split panes, tab order, and restores default single layout.</p>
              </div>
              <button
                type="button"
                onClick={handleResetLayout}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
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
              <Shield className="w-3.5 h-3.5 text-amber-400" />
              <span>Credential Vault</span>
            </div>

            <div className="p-2.5 bg-plinky-950 rounded border border-plinky-800 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-200">Delete Vault</p>
                  <p className="text-[11px] text-slate-500">Permanently deletes the vault and every password saved in it.</p>
                </div>
                <button
                  type="button"
                  onClick={() => { setDeleteResult(null); setDeleteStep('warn1'); }}
                  disabled={!vaultExists || deleteStep !== 'idle'}
                  title={vaultExists ? 'Delete the vault' : 'There is no vault'}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-red-950/40 border border-red-800/50 hover:bg-red-900/50 text-red-300 disabled:opacity-40 disabled:pointer-events-none transition"
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
                    <button type="button" onClick={() => setDeleteStep('warn2')} className="px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white">Yes, continue</button>
                  </div>
                </div>
              )}

              {(deleteStep === 'warn2' || deleteStep === 'deleting') && (
                <div role="alertdialog" aria-label="Final warning" className="p-2.5 rounded border border-red-600/60 bg-red-950/40 space-y-2">
                  <p className="flex items-start space-x-1.5 text-red-200">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                    <span>
                      Last warning: this can't be undone. If you might need these passwords, cancel and use
                      Vault → Export to KeePass first.
                    </span>
                  </p>
                  <div className="flex justify-end space-x-2">
                    <button type="button" onClick={() => setDeleteStep('idle')} disabled={deleteStep === 'deleting'} className="px-3 py-1 rounded bg-plinky-800 hover:bg-plinky-700 disabled:opacity-40">Cancel</button>
                    <button type="button" onClick={handleDeleteVault} disabled={deleteStep === 'deleting'} className="px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-white font-medium disabled:opacity-40">
                      {deleteStep === 'deleting' ? 'Deleting…' : 'Delete vault permanently'}
                    </button>
                  </div>
                </div>
              )}

              {deleteResult && <p role="status" className="text-[11px] text-slate-300">{deleteResult}</p>}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 bg-plinky-950 border-t border-plinky-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
