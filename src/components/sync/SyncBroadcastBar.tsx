import React, { useState } from 'react';
import { SyncChannel } from '../../types/session';
import { terminalManager } from '../../services/terminalManager';
import { broadcastSyncInput } from '../../services/tauriBridge';
import { Radio, Send, Terminal, AlertTriangle, X } from 'lucide-react';

interface SyncBroadcastBarProps {
  onClose?: () => void;
}

export const SyncBroadcastBar: React.FC<SyncBroadcastBarProps> = () => {
  const [broadcastTarget, setBroadcastTarget] = useState<SyncChannel | 'all'>('all');
  const [command, setCommand] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<{ command: string; lineCount: number } | null>(null);

  const executeBroadcast = async (cmd: string) => {
    const formatted = cmd.endsWith('\n') ? cmd : `${cmd}\n`;
    const data = new TextEncoder().encode(formatted);

    if (broadcastTarget === 'all') {
      for (const ch of ['A', 'B', 'C', 'D'] as const) {
        await broadcastSyncInput(ch, data);
      }
    } else {
      await broadcastSyncInput(broadcastTarget, data);
    }

    terminalManager.broadcastInput(broadcastTarget, cmd);
    setCommand('');
  };

  const handleBroadcast = (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;

    // D6 Multi-line paste / script safety check
    const lines = command.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length >= 2) {
      setPendingConfirmation({ command, lineCount: lines.length });
    } else {
      executeBroadcast(command);
    }
  };

  const getTargetBadgeColor = (target: SyncChannel | 'all') => {
    switch (target) {
      case 'all': return 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40';
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
              onClick={() => setBroadcastTarget(target)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono border transition ${
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
          <Terminal className="w-3.5 h-3.5 absolute left-2.5 text-slate-500 pointer-events-none" />
          <input
            type="text"
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder={`Type command to simultaneously broadcast to ${broadcastTarget === 'all' ? 'ALL active sessions' : `Channel ${broadcastTarget}`}... (e.g. uptime, df -h, systemctl status)`}
            className="w-full pl-8 pr-3 py-1 bg-plinky-950 border border-plinky-700 rounded text-xs text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-sky-500 font-mono transition"
          />
        </div>

        <button
          type="submit"
          disabled={!command.trim()}
          className="flex items-center space-x-1 px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium disabled:opacity-40 disabled:pointer-events-none transition"
        >
          <Send className="w-3 h-3" />
          <span>Broadcast</span>
        </button>
      </form>

      {/* D6 Multi-Line Broadcast Confirmation Modal */}
      {pendingConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="bg-plinky-900 border border-amber-500/60 rounded-xl shadow-2xl max-w-lg w-full p-5 text-slate-100">
            <div className="flex items-start space-x-3 mb-3">
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Multi-Line Broadcast Warning (D6)</h3>
                  <button
                    onClick={() => setPendingConfirmation(null)}
                    className="p-1 text-slate-400 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  You are about to simultaneously execute a multi-line script ({pendingConfirmation.lineCount} lines) across all sessions in {broadcastTarget === 'all' ? 'ALL active channels' : `Channel ${broadcastTarget}`}.
                </p>
              </div>
            </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 font-mono text-[11px] text-slate-300 max-h-40 overflow-y-auto mb-4 whitespace-pre">
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
                className="px-3.5 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs shadow-xs"
              >
                Confirm & Broadcast ({pendingConfirmation.lineCount} lines)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
