import React from 'react';
import { TerminalTab } from '../../types/session';
import { Radio, ShieldCheck, Terminal } from 'lucide-react';

interface StatusBarProps {
  tabs: TerminalTab[];
  activeTabId: string | null;
  broadcastOpen?: boolean;
  onToggleBroadcast?: () => void;
}

const CHANNEL_CHIP: Record<'A' | 'B' | 'C' | 'D', string> = {
  A: 'bg-ch-a/20 text-ch-a border border-ch-a/30',
  B: 'bg-ch-b/20 text-ch-b border border-ch-b/30',
  C: 'bg-ch-c/20 text-ch-c border border-ch-c/30',
  D: 'bg-ch-d/20 text-ch-d border border-ch-d/30',
};

export const StatusBar: React.FC<StatusBarProps> = ({ tabs, activeTabId, broadcastOpen, onToggleBroadcast }) => {
  const liveCount = tabs.filter(t => t.status === 'live').length;
  const activeTab = tabs.find(t => t.id === activeTabId);

  // Live tabs only: a dead tab still assigned to A counted as a receiver,
  // though broadcasts reach live sessions only.
  const channelCount = tabs.reduce<Record<string, number>>((acc, t) => {
    if (t.syncChannel !== 'none' && t.status === 'live') {
      acc[t.syncChannel] = (acc[t.syncChannel] || 0) + 1;
    }
    return acc;
  }, {});

  return (
    <footer className="h-6 bg-plinky-950 border-t border-plinky-800 px-3 flex items-center justify-between gap-3 text-meta text-slate-400 select-none tabular-nums whitespace-nowrap overflow-hidden">
      {/* Left. "Plink Transport: Ready" was a fixed string that never
          changed; "Active Tabs" counted dead tabs. */}
      <div className="flex items-center space-x-3 min-w-0">
        <div className="flex items-center space-x-1 text-slate-300 whitespace-nowrap">
          <Terminal className="w-3 h-3 text-sky-400" />
          <span>{tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}{tabs.length ? ` · ${liveCount} live` : ''}</span>
        </div>

        {activeTab && (
          <>
            <span className="text-plinky-600">|</span>
            <span className="text-slate-300 truncate min-w-0">
              Current: <strong className="text-sky-300">{activeTab.sessionName}</strong>
              {activeTab.hostname && !activeTab.sessionName.includes(activeTab.hostname)
                ? ` (${activeTab.hostname}${activeTab.port ? `:${activeTab.port}` : ''})` : ''}
            </span>
          </>
        )}
      </div>

      {/* Right: Sync Broadcast & Free Type Mode Status */}
      <div className="flex items-center space-x-3">
        {/* Sync Input Channels Breakdown */}
        <div className="flex items-center space-x-1.5 whitespace-nowrap">
          <button
            type="button"
            onClick={onToggleBroadcast}
            aria-pressed={!!broadcastOpen}
            title="Show or hide the broadcast bar (Ctrl+Shift+B)"
            className={`flex items-center space-x-1 px-1 rounded hover:bg-plinky-800 ${broadcastOpen ? 'text-sky-300' : 'text-slate-400'}`}
          >
            <Radio className="w-3 h-3" />
            <span>Broadcast</span>
          </button>
          {(['A', 'B', 'C', 'D'] as const).map(ch => {
            const count = channelCount[ch] || 0;
            return (
              <span
                key={ch}
                className={`px-1 py-px rounded text-meta font-bold ${
                  count > 0
                    ? CHANNEL_CHIP[ch]
                    : 'text-plinky-muted'
                }`}
              >
                {ch}:{count}
              </span>
            );
          })}
        </div>

        <span className="text-plinky-600">|</span>

        {/* Design doc R3: plink verifies host keys; Plinky never reads them
            out of terminal text. "R3 Safe (Zero Hostkey Scrape)" was that
            shorthand, meaningless to a user. */}
        <div
          className="hidden lg:flex items-center space-x-1 text-slate-400 whitespace-nowrap"
          title="PuTTY verifies every server's host key. Plinky only shows you the fingerprint and passes on your answer."
        >
          <ShieldCheck className="w-3 h-3 text-sky-400" />
          <span>Host keys verified by PuTTY</span>
        </div>
      </div>
    </footer>
  );
};
