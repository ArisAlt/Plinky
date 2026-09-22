import React from 'react';
import { TerminalTab } from '../../types/session';
import { Radio, ShieldCheck, Terminal, Wifi } from 'lucide-react';

interface StatusBarProps {
  tabs: TerminalTab[];
  activeTabId: string | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({ tabs, activeTabId }) => {
  const activeTab = tabs.find(t => t.id === activeTabId);

  // Group tabs by channel
  const channelCount = tabs.reduce<Record<string, number>>((acc, t) => {
    if (t.syncChannel !== 'none') {
      acc[t.syncChannel] = (acc[t.syncChannel] || 0) + 1;
    }
    return acc;
  }, {});

  return (
    <footer className="h-6 bg-plinky-950 border-t border-plinky-800 px-3 flex items-center justify-between text-[11px] text-slate-400 select-none font-mono">
      {/* Left: Active Session & Transport Status */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-1.5 text-emerald-400">
          <Wifi className="w-3 h-3" />
          <span>Plink Transport: Ready</span>
        </div>

        <span className="text-plinky-700">|</span>

        <div className="flex items-center space-x-1 text-slate-300">
          <Terminal className="w-3 h-3 text-sky-400" />
          <span>Active Tabs: {tabs.length}</span>
        </div>

        {activeTab && (
          <>
            <span className="text-plinky-700">|</span>
            <span className="text-slate-300">
              Current: <strong className="text-sky-300">{activeTab.sessionName}</strong> ({activeTab.hostname}:{activeTab.port})
            </span>
          </>
        )}
      </div>

      {/* Right: Sync Broadcast & Free Type Mode Status */}
      <div className="flex items-center space-x-3">
        {/* Sync Input Channels Breakdown */}
        <div className="flex items-center space-x-1.5">
          <Radio className="w-3 h-3 text-sky-400" />
          <span>Sync:</span>
          {(['A', 'B', 'C', 'D'] as const).map(ch => {
            const count = channelCount[ch] || 0;
            return (
              <span
                key={ch}
                className={`px-1 py-0.2 rounded text-[10px] font-bold ${
                  count > 0
                    ? ch === 'A'
                      ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                      : ch === 'B'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : ch === 'C'
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                    : 'text-slate-600'
                }`}
              >
                {ch}:{count}
              </span>
            );
          })}
        </div>

        <span className="text-plinky-700">|</span>

        {/* Free Type Mode Indicator */}
        <div className="flex items-center space-x-1">
          <span>FreeType:</span>
          <span className={`font-semibold ${activeTab?.freeTypeMode ? 'text-sky-400' : 'text-slate-500'}`}>
            {activeTab?.freeTypeMode ? 'ON' : 'OFF'}
          </span>
        </div>

        <span className="text-plinky-700">|</span>

        {/* PuTTY R3 Safety */}
        <div className="flex items-center space-x-1 text-slate-400">
          <ShieldCheck className="w-3 h-3 text-sky-400" />
          <span>R3 Safe (Zero Hostkey Scrape)</span>
        </div>
      </div>
    </footer>
  );
};
