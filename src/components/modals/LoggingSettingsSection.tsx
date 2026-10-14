import React, { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { getLoggingSettings, setLoggingSettings, pickLogFolder, LoggingSettings } from '../../services/tauriBridge';

/** Settings > Logging: every session logged to a file of its own, by folder,
 *  session and time, without a click each time. A session can choose for
 *  itself in Session Settings > Advanced. The setting is the backend's
 *  (logging.json): a GNS3 console starts before this page exists. */
export const LoggingSettingsSection: React.FC<{ isOpen: boolean }> = ({ isOpen }) => {
  const [s, setS] = useState<LoggingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    getLoggingSettings().then(setS).catch(e => setError(String(e)));
  }, [isOpen]);

  if (!s) return null; // not in the desktop app: nothing to set

  const save = async (next: { enabled?: boolean; dir?: string | null; mode?: LoggingSettings['mode'] }) => {
    setError(null);
    try {
      const dir = next.dir !== undefined ? next.dir : (s.default_dir ? null : s.dir);
      setS(await setLoggingSettings(next.enabled ?? s.enabled, dir, next.mode ?? s.mode));
    } catch (e) {
      setError(String(e));
    }
  };

  const choose = async () => {
    try {
      const dir = await pickLogFolder();
      if (dir) await save({ dir });
    } catch (e) {
      setError(String(e));
    }
  };

  const sep = s.dir.includes('\\') ? '\\' : '/';

  return (
    <div className="space-y-3">
      <div className="flex items-center space-x-2 text-slate-300 font-semibold border-b border-plinky-800 pb-1">
        <ScrollText className="w-3.5 h-3.5 text-slate-400" />
        <span>Logging</span>
      </div>
      <div className="p-3 bg-plinky-950 rounded border border-plinky-800 space-y-3">
        <label className="flex items-start space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
            aria-label="Log every session automatically"
            className="mt-0.5 rounded border-plinky-700 bg-plinky-900 text-sky-500 focus:ring-0 cursor-pointer"
          />
          <div className="select-none">
            <span className="text-slate-200 font-medium block">Log every session automatically</span>
            <span className="text-meta text-plinky-muted block">
              Each connection gets its own file. A session can choose for itself: Session Settings, Advanced.
            </span>
          </div>
        </label>

        <div className="space-y-1">
          <div className="text-meta text-slate-400 font-medium">Log folder</div>
          <div className="flex items-center gap-2">
            <code data-log-folder className="flex-1 min-w-0 truncate px-2 py-1 rounded bg-plinky-900 border border-plinky-800 text-slate-200" title={s.dir}>{s.dir}</code>
            <button type="button" onClick={() => void choose()} className="px-2 py-1 rounded border border-plinky-700 text-slate-200 hover:bg-plinky-800 transition">
              Choose…
            </button>
            {!s.default_dir && (
              <button type="button" onClick={() => void save({ dir: null })} className="px-2 py-1 rounded border border-plinky-700 text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition">
                Default
              </button>
            )}
          </div>
          <div className="text-meta text-plinky-muted font-mono break-all">
            {`${s.dir}${sep}<folder>${sep}<session>${sep}2026-10-14_16-05-33.log`}
          </div>
          <div className="text-meta text-plinky-muted">Sessions that aren't saved (GNS3 consoles, quick connects, the local shell) go under Unsaved.</div>
        </div>

        <div className="space-y-1">
          <div className="text-meta text-slate-400 font-medium">What is written</div>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['printable', 'Text only', 'Colours and control codes removed: reads in any editor'],
              ['all', 'Everything', 'Every byte as received, colour codes included'],
            ] as const).map(([mode, label, hint]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={s.mode === mode}
                onClick={() => void save({ mode })}
                className={`py-1.5 px-2 rounded text-left transition border ${
                  s.mode === mode
                    ? 'bg-sky-500/20 border-sky-500/50 text-sky-300 font-medium'
                    : 'bg-plinky-900 border-plinky-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="font-semibold text-meta">{label}</div>
                <div className="text-meta text-slate-400">{hint}</div>
              </button>
            ))}
          </div>
        </div>
        {error && <p role="alert" className="text-meta text-rose-400">{error}</p>}
      </div>
    </div>
  );
};
