import React, { useState, useEffect } from 'react';
import { Settings, X, Type, Shield, Monitor, RotateCcw, Check } from 'lucide-react';
import { detectPutty, PuttyDetectInfo } from '../../services/tauriBridge';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  fontFamily: string;
  onChangeFontFamily: (font: string) => void;
  fontSize: number;
  onChangeFontSize: (size: number) => void;
  cursorStyle: 'block' | 'bar' | 'underline';
  onChangeCursorStyle: (style: 'block' | 'bar' | 'underline') => void;
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
  onResetLayout,
}) => {
  const [puttyInfo, setPuttyInfo] = useState<PuttyDetectInfo | null>(null);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    if (isOpen) {
      detectPutty().then(setPuttyInfo);
      setResetDone(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleResetLayout = () => {
    onResetLayout();
    setResetDone(true);
    setTimeout(() => setResetDone(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none">
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
