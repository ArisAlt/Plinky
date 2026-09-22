import React, { useState } from 'react';
import { SyncChannel } from '../../types/session';
import { terminalManager } from '../../services/terminalManager';
import { Radio, Send, Terminal } from 'lucide-react';

interface SyncBroadcastBarProps {
  onClose?: () => void;
}

export const SyncBroadcastBar: React.FC<SyncBroadcastBarProps> = () => {
  const [broadcastTarget, setBroadcastTarget] = useState<SyncChannel | 'all'>('all');
  const [command, setCommand] = useState('');

  const handleBroadcast = (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;

    terminalManager.broadcastInput(broadcastTarget, command);
    setCommand('');
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
    <div className="bg-plinky-900 border-t border-plinky-800 px-3 py-2 flex items-center space-x-3 text-xs select-none">
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
                  ? getTargetBadgeColor(target) + ' font-bold shadow-sm'
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
            className="w-full pl-8 pr-3 py-1 bg-plinky-950 border border-plinky-700 rounded text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 font-mono transition"
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
    </div>
  );
};
