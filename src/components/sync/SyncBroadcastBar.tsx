import React, { useEffect, useRef, useState } from 'react';
import { SyncChannel, TerminalTab } from '../../types/session';
import { terminalManager } from '../../services/terminalManager';
import { broadcastSyncInput, isTauriEnvironment } from '../../services/tauriBridge';
import { announceBroadcast, broadcastHistory } from '../../services/broadcast';
import { Radio, Send, Terminal, AlertTriangle, X } from 'lucide-react';

interface SyncBroadcastBarProps {
  /** Open tabs, to say before sending how many sessions a command reaches. */
  tabs: Pick<TerminalTab, 'id' | 'status' | 'syncChannel'>[];
  onClose?: () => void;
}

/** How long a first Enter on a wide broadcast stays armed. */
export const ARM_MS = 4000;

export const SyncBroadcastBar: React.FC<SyncBroadcastBarProps> = ({ tabs }) => {
  const [broadcastTarget, setBroadcastTarget] = useState<SyncChannel | 'all'>('all');
  const [command, setCommand] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<{ command: string; lineCount: number } | null>(null);
  // What the last broadcast did. It used to say nothing at all, even when
  // no session was live on the channel and the command went nowhere.
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resultTimer.current), []);
  // A command for every live session needs a second Enter. It sat one stray
  // Enter away from every open router, and said how many only afterwards.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  const disarm = () => {
    clearTimeout(armTimer.current);
    setArmed(false);
  };

  // Same rule as the backend's router: only live sessions receive input.
  const liveTargets = tabs.filter(t =>
    t.status === 'live' && (broadcastTarget === 'all' || t.syncChannel === broadcastTarget)
  ).length;

  const executeBroadcast = async (cmd: string) => {
    const formatted = cmd.endsWith('\n') ? cmd : `${cmd}\n`;
    const data = new TextEncoder().encode(formatted);
    broadcastHistory.push(cmd);

    const ids = isTauriEnvironment()
      ? await broadcastSyncInput(broadcastTarget, data)
      : terminalManager.broadcastInput(broadcastTarget, cmd);
    setCommand('');
    announceBroadcast(ids);

    const n = ids.length;
    setResult(n > 0
      ? { ok: true, text: `Sent to ${n} session${n === 1 ? '' : 's'}` }
      : { ok: false, text: `Not sent: no live session ${broadcastTarget === 'all' ? 'open' : `on CH-${broadcastTarget}`}` });
    clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => setResult(null), 4000);
  };

  const recall = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const next = e.key === 'ArrowUp' ? broadcastHistory.up(command) : broadcastHistory.down();
    if (next === null) return;
    e.preventDefault();
    setCommand(next);
  };

  const confirmIfScript = (text: string): boolean => {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return false;
    setPendingConfirmation({ command: text, lineCount: lines.length });
    return true;
  };

  const handleBroadcast = (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;
    if (confirmIfScript(command)) return;
    if (broadcastTarget === 'all' && liveTargets > 1 && !armed) {
      setArmed(true);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    disarm();
    executeBroadcast(command);
  };

  // A text input drops line breaks on paste, so the script check above
  // never saw one: a pasted script went out as a single run-on line. Catch
  // the paste itself, while the line breaks are still in it.
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!/[\r\n]/.test(pasted)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? command.length;
    const end = el.selectionEnd ?? command.length;
    const text = command.slice(0, start) + pasted + command.slice(end);
    if (!confirmIfScript(text)) setCommand(text.replace(/[\r\n]+/g, ' ').trim());
  };

  const getTargetBadgeColor = (target: SyncChannel | 'all') => {
    switch (target) {
      case 'all': return 'bg-sky-500/15 text-sky-200 border-sky-500/40';
      case 'A': return 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40';
      case 'B': return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
      case 'C': return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      case 'D': return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
      default: return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  return (
    <div className="bg-plinky-900 border-t border-plinky-800 px-3 py-2 flex items-center space-x-3 text-xs select-none relative">
      {/* Target Selector */}
      <div className="flex items-center space-x-1.5 flex-shrink-0">
        <Radio className="w-3.5 h-3.5 text-sky-400" />
        <span className="font-semibold text-slate-300">Sync Broadcast:</span>

        <div className="flex items-center space-x-1 ml-1">
          {(['all', 'A', 'B', 'C', 'D'] as const).map(target => (
            <button
              key={target}
              onClick={() => { setBroadcastTarget(target); disarm(); }}
              className={`px-2 py-0.5 rounded text-meta font-semibold border transition ${
                broadcastTarget === target
                  ? getTargetBadgeColor(target) + ' font-bold shadow-xs'
                  : 'bg-plinky-950 text-slate-400 border-plinky-700 hover:text-slate-200'
              }`}
            >
              {target === 'all' ? 'ALL TABS' : `CH-${target}`}
            </button>
          ))}
        </div>
      </div>

      {/* Input Form */}
      <form onSubmit={handleBroadcast} className="flex-1 flex items-center space-x-2">
        <div className="relative flex-1 flex items-center">
          <Terminal className="w-3.5 h-3.5 absolute left-2.5 text-plinky-muted pointer-events-none" />
          <input
            type="text"
            value={command}
            onChange={e => { setCommand(e.target.value); disarm(); }}
            onKeyDown={recall}
            onPaste={handlePaste}
            aria-label="Broadcast command"
            title="Up / Down: commands sent before"
            placeholder={`Command for ${broadcastTarget === 'all' ? 'every live session' : `channel ${broadcastTarget}`}`}
            className="w-full pl-8 pr-3 py-1 bg-plinky-950 border border-plinky-700 rounded text-xs text-slate-100 placeholder-plinky-muted focus:outline-none focus:border-sky-500 font-mono transition"
          />
        </div>

        <button
          type="submit"
          disabled={!command.trim()}
          title={armed ? 'Press Enter again to send' : undefined}
          className={`flex items-center space-x-1 px-3 py-1 rounded font-medium whitespace-nowrap tabular-nums disabled:opacity-40 disabled:pointer-events-none transition ${
            armed ? 'bg-amber-500 hover:bg-amber-400 text-amber-950' : 'bg-sky-700 hover:brightness-110 text-on-accent'
          }`}
        >
          <Send className="w-3 h-3" />
          <span>{armed ? `Enter again: send to ${liveTargets}` : `Send to ${liveTargets}`}</span>
        </button>
        <span
          role="status"
          aria-live="polite"
          className={`text-meta whitespace-nowrap ${result?.ok ? 'text-emerald-400' : 'text-amber-400'}`}
        >
          {result?.text}
        </span>
      </form>

      {/* D6 Multi-Line Broadcast Confirmation Modal */}
      {pendingConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-plinky-950/75 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="bg-plinky-900 border border-amber-500/60 rounded-xl shadow-2xl max-w-lg w-full p-5 text-slate-100">
            <div className="flex items-start space-x-3 mb-3">
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-white">Multi-line broadcast</h3>
                  <button
                    onClick={() => setPendingConfirmation(null)}
                    aria-label="Cancel broadcast"
                    className="p-1 text-slate-400 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {pendingConfirmation.lineCount} lines will run, one after another, in {liveTargets} live session{liveTargets === 1 ? '' : 's'}{broadcastTarget === 'all' ? '' : ` on channel ${broadcastTarget}`}.
                </p>
              </div>
            </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 font-mono text-meta text-slate-300 max-h-40 overflow-y-auto mb-4 whitespace-pre">
              {pendingConfirmation.command}
            </div>

            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => setPendingConfirmation(null)}
                className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  executeBroadcast(pendingConfirmation.command);
                  setPendingConfirmation(null);
                }}
                className="px-3.5 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-amber-950 font-medium text-xs shadow-xs"
              >
                Send {pendingConfirmation.lineCount} lines to {liveTargets}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
