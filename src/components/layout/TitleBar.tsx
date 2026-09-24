import React, { useState, useEffect, useRef } from 'react';
import { PuttySession } from '../../types/session';
import { 
  Terminal, 
  Plus, 
  Folder, 
  HardDrive, 
  Network, 
  Settings, 
  Play, 
  Key,
  Shield,
  Clock,
  X,
  Trash2
} from 'lucide-react';

interface TitleBarProps {
  onQuickConnect: (host: string, port: number, username?: string) => void;
  onNewSession: () => void;
  activeView: 'sessions' | 'sftp' | 'tunnels' | 'keys' | 'vault';
  setActiveView: (view: 'sessions' | 'sftp' | 'tunnels' | 'keys' | 'vault') => void;
  onOpenSettings?: () => void;
  sessions?: PuttySession[];
}

export const TitleBar: React.FC<TitleBarProps> = ({
  onQuickConnect,
  onNewSession,
  activeView,
  setActiveView,
  onOpenSettings,
  sessions = [],
}) => {
  const [quickHost, setQuickHost] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [history, setHistory] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('plinky_quick_connect_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const saveHistoryItem = (item: string) => {
    const updated = [item, ...history.filter(h => h !== item)].slice(0, 15);
    setHistory(updated);
    try {
      localStorage.setItem('plinky_quick_connect_history', JSON.stringify(updated));
    } catch (e) {
      console.warn('Failed to save quick connect history:', e);
    }
  };

  const removeHistoryItem = (e: React.MouseEvent, item: string) => {
    e.stopPropagation();
    const updated = history.filter(h => h !== item);
    setHistory(updated);
    try {
      localStorage.setItem('plinky_quick_connect_history', JSON.stringify(updated));
    } catch (e) {
      console.warn('Failed to save quick connect history:', e);
    }
  };

  const clearAllHistory = (e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory([]);
    try {
      localStorage.removeItem('plinky_quick_connect_history');
    } catch (e) {
      console.warn('Failed to clear quick connect history:', e);
    }
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const executeConnect = (rawTarget: string) => {
    if (!rawTarget.trim()) return;
    saveHistoryItem(rawTarget.trim());

    let target = rawTarget.trim();
    let username: string | undefined;
    let port = 22;

    if (target.includes('@')) {
      const atIdx = target.indexOf('@');
      username = target.slice(0, atIdx);
      target = target.slice(atIdx + 1);
    }

    if (target.includes(':')) {
      const parts = target.split(':');
      target = parts[0];
      port = parseInt(parts[1], 10) || 22;
    }

    onQuickConnect(target, port, username);
    setQuickHost('');
    setIsDropdownOpen(false);
  };

  const handleQuickConnectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isDropdownOpen && selectedIndex >= 0 && combinedSuggestions[selectedIndex]) {
      executeConnect(combinedSuggestions[selectedIndex].target);
    } else {
      executeConnect(quickHost);
    }
  };

  // Filter suggestions from saved sessions and history
  const q = quickHost.trim().toLowerCase();

  const sessionSuggestions = sessions
    .filter(s => {
      if (!q) return true;
      const name = (s.name || '').toLowerCase();
      const host = (s.hostname || s.host_name || '').toLowerCase();
      return name.includes(q) || host.includes(q);
    })
    .slice(0, 6)
    .map(s => ({
      type: 'session' as const,
      label: s.name,
      target: s.username ? `${s.username}@${s.hostname || 'localhost'}:${s.port || 22}` : `${s.hostname || 'localhost'}:${s.port || 22}`,
      subtext: `${s.protocol} - ${s.hostname || 'localhost'}:${s.port || 22}`,
    }));

  const historySuggestions = history
    .filter(h => !q || h.toLowerCase().includes(q))
    .slice(0, 8)
    .map(h => ({
      type: 'history' as const,
      label: h,
      target: h,
      subtext: 'Recent connection',
    }));

  const combinedSuggestions = [...historySuggestions, ...sessionSuggestions];

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIsDropdownOpen(true);
      setSelectedIndex(prev => (prev + 1 < combinedSuggestions.length ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIsDropdownOpen(true);
      setSelectedIndex(prev => (prev - 1 >= 0 ? prev - 1 : combinedSuggestions.length - 1));
    } else if (e.key === 'Escape') {
      setIsDropdownOpen(false);
      setSelectedIndex(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleQuickConnectSubmit(e);
    }
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

          <button
            onClick={() => setActiveView('vault')}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded transition ${
              activeView === 'vault'
                ? 'bg-plinky-800 text-sky-400 font-medium'
                : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/60'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>Vault</span>
          </button>
        </div>
      </div>

      {/* Center Quick Connect with History & Autocomplete */}
      <div ref={dropdownRef} className="relative w-80">
        <form onSubmit={handleQuickConnectSubmit} className="flex items-center space-x-1.5 w-full">
          <input
            ref={inputRef}
            type="text"
            value={quickHost}
            onChange={(e) => {
              setQuickHost(e.target.value);
              setIsDropdownOpen(true);
              setSelectedIndex(-1);
            }}
            onFocus={() => setIsDropdownOpen(true)}
            onKeyDown={handleInputKeyDown}
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

        {/* Dropdown Menu */}
        {isDropdownOpen && combinedSuggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 bg-plinky-900 border border-plinky-700/80 rounded-lg shadow-2xl py-1 z-50 text-xs overflow-hidden max-h-72 flex flex-col">
            <div className="overflow-y-auto flex-1">
              {combinedSuggestions.map((item, idx) => {
                const isSelected = idx === selectedIndex;
                return (
                  <div
                    key={`${item.type}-${item.target}-${idx}`}
                    onClick={() => executeConnect(item.target)}
                    className={`flex items-center justify-between px-3 py-1.5 cursor-pointer transition ${
                      isSelected
                        ? 'bg-sky-600/30 text-sky-200'
                        : 'hover:bg-plinky-800 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center space-x-2 min-w-0 flex-1">
                      {item.type === 'history' ? (
                        <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      ) : (
                        <Terminal className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      )}
                      <div className="flex flex-col min-w-0 truncate">
                        <span className="font-mono text-xs truncate">{item.label}</span>
                        <span className="text-[10px] text-slate-500 truncate">{item.subtext}</span>
                      </div>
                    </div>

                    {item.type === 'history' && (
                      <button
                        type="button"
                        onClick={(e) => removeHistoryItem(e, item.target)}
                        title="Remove from history"
                        aria-label={`Remove ${item.target} from history`}
                        className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition ml-2"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {history.length > 0 && (
              <div className="p-1.5 border-t border-plinky-800 bg-plinky-950/60 flex items-center justify-between">
                <span className="text-[10px] text-slate-500 font-medium px-1">Quick Connect History</span>
                <button
                  type="button"
                  onClick={clearAllHistory}
                  className="flex items-center space-x-1 text-[10px] text-slate-400 hover:text-rose-400 px-1.5 py-0.5 rounded hover:bg-plinky-800 transition"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                  <span>Clear All</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

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
          onClick={onOpenSettings}
          title="Settings & PuTTY Path"
          className="p-1.5 rounded hover:bg-plinky-800 text-slate-400 hover:text-slate-200 transition"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};

