import React, { useState } from 'react';
import { 
  Terminal, 
  Plus, 
  Folder, 
  HardDrive, 
  Network, 
  Settings, 
  Play, 
  Key
} from 'lucide-react';

interface TitleBarProps {
  onQuickConnect: (host: string, port: number) => void;
  onNewSession: () => void;
  activeView: 'sessions' | 'sftp' | 'tunnels' | 'keys';
  setActiveView: (view: 'sessions' | 'sftp' | 'tunnels' | 'keys') => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  onQuickConnect,
  onNewSession,
  activeView,
  setActiveView,
}) => {
  const [quickHost, setQuickHost] = useState('');

  const handleQuickConnectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickHost.trim()) return;

    let host = quickHost.trim();
    let port = 22;

    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      port = parseInt(parts[1], 10) || 22;
    }

    onQuickConnect(host, port);
    setQuickHost('');
  };

  return (
    <header className="h-11 bg-plinky-900 border-b border-plinky-800 px-3 flex items-center justify-between select-none text-xs">
      {/* Brand & Left Navigation */}
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-2">
          <div className="h-6 w-6 rounded bg-sky-500/20 border border-sky-500/40 flex items-center justify-center">
            <Terminal className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <span className="font-bold text-sm tracking-tight text-white font-mono">PLINKY</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 font-mono">
            PuTTY v0.85
          </span>
        </div>

        {/* View Switchers */}
        <div className="flex items-center space-x-1 pl-2 border-l border-plinky-800">
          <button
            onClick={() => setActiveView('sessions')}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded transition ${
              activeView === 'sessions'
                ? 'bg-plinky-800 text-sky-300 font-medium'
                : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/60'
            }`}
          >
            <Folder className="w-3.5 h-3.5" />
            <span>Sessions</span>
          </button>

          <button
            onClick={() => setActiveView('sftp')}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded transition ${
              activeView === 'sftp'
                ? 'bg-plinky-800 text-emerald-300 font-medium'
                : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/60'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>SFTP Pane</span>
          </button>

          <button
            onClick={() => setActiveView('tunnels')}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded transition ${
              activeView === 'tunnels'
                ? 'bg-plinky-800 text-purple-300 font-medium'
                : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/60'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            <span>SSH Tunnels</span>
          </button>

          <button
            onClick={() => setActiveView('keys')}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded transition ${
              activeView === 'keys'
                ? 'bg-plinky-800 text-amber-300 font-medium'
                : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/60'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>Host Keys</span>
          </button>
        </div>
      </div>

      {/* Center Quick Connect */}
      <form onSubmit={handleQuickConnectSubmit} className="flex items-center space-x-1.5 w-80">
        <input
          type="text"
          value={quickHost}
          onChange={(e) => setQuickHost(e.target.value)}
          placeholder="Quick Connect: user@host[:port]..."
          className="flex-1 px-2.5 py-1 bg-plinky-950 border border-plinky-700 rounded text-xs text-slate-200 placeholder-slate-500 font-mono focus:outline-none focus:border-sky-500 transition"
        />
        <button
          type="submit"
          disabled={!quickHost.trim()}
          title="Quick Connect via plink"
          className="p-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40 disabled:pointer-events-none transition"
        >
          <Play className="w-3 h-3 fill-current" />
        </button>
      </form>

      {/* Right Actions */}
      <div className="flex items-center space-x-2">
        <button
          onClick={onNewSession}
          className="flex items-center space-x-1 px-2.5 py-1 rounded bg-sky-600/80 hover:bg-sky-500 text-white font-medium transition"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Session</span>
        </button>

        <button
          title="Settings & PuTTY Path"
          className="p-1.5 rounded hover:bg-plinky-800 text-slate-400 hover:text-slate-200 transition"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
