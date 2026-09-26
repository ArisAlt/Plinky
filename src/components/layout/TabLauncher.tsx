import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Terminal, Clock, Server, Plus } from 'lucide-react';
import { PuttySession } from '../../types/session';

interface TabLauncherProps {
  /** Screen position (below the "+" button): the tab bar scrolls, so an
   *  absolutely positioned menu inside it would be clipped. */
  anchor: { top: number; left: number };
  sessions: PuttySession[];
  recentNames: string[];
  onOpenSession: (session: PuttySession) => void;
  onOpenLocalShell: () => void;
  onNewSession: () => void;
  onClose: () => void;
}

type Item =
  | { kind: 'local' }
  | { kind: 'session'; session: PuttySession; recent: boolean }
  | { kind: 'new' };

const RECENT_SHOWN = 5;

/**
 * The tab bar's "+" menu (T-011). It used to open the first saved session
 * in the list, whichever that was. Now: Local Shell, recent sessions, every
 * saved session (searchable) and New Session, all reachable from the
 * keyboard.
 */
export const TabLauncher: React.FC<TabLauncherProps> = ({
  anchor, sessions, recentNames, onOpenSession, onOpenLocalShell, onNewSession, onClose,
}) => {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (s: PuttySession) =>
      !q || [s.name, s.hostname, s.host_name, s.username, s.folder].some(v => v && v.toLowerCase().includes(q));
    const byName = new Map(sessions.map(s => [s.name, s]));
    const recent = recentNames
      .map(n => byName.get(n))
      .filter((s): s is PuttySession => !!s && matches(s))
      .slice(0, RECENT_SHOWN);
    const recentSet = new Set(recent.map(s => s.name));
    const rest = sessions
      .filter(s => matches(s) && !recentSet.has(s.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const list: Item[] = [];
    if (!q || 'local shell'.includes(q)) list.push({ kind: 'local' });
    recent.forEach(session => list.push({ kind: 'session', session, recent: true }));
    rest.forEach(session => list.push({ kind: 'session', session, recent: false }));
    list.push({ kind: 'new' });
    return list;
  }, [sessions, recentNames, query]);

  useEffect(() => setIndex(0), [query]);

  // Click outside closes.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const choose = (item: Item) => {
    if (item.kind === 'local') onOpenLocalShell();
    else if (item.kind === 'session') onOpenSession(item.session);
    else onNewSession();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(i => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[index]) choose(items[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const row = (item: Item, i: number) => {
    const active = i === index;
    const base = `w-full flex items-center space-x-2 px-2.5 py-1.5 text-left rounded transition ${
      active ? 'bg-sky-600/30 text-sky-100' : 'text-slate-300 hover:bg-plinky-800'
    }`;
    if (item.kind === 'local') {
      return (
        <button key="local" role="option" aria-selected={active} className={base} onMouseEnter={() => setIndex(i)} onClick={() => choose(item)}>
          <Terminal className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
          <span>Local Shell</span>
        </button>
      );
    }
    if (item.kind === 'new') {
      return (
        <button key="new" role="option" aria-selected={active} className={base} onMouseEnter={() => setIndex(i)} onClick={() => choose(item)}>
          <Plus className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
          <span>New Session…</span>
        </button>
      );
    }
    const s = item.session;
    const host = s.hostname || s.host_name;
    return (
      <button key={`${item.recent ? 'r' : 's'}:${s.name}`} role="option" aria-selected={active} className={base} onMouseEnter={() => setIndex(i)} onClick={() => choose(item)}>
        {item.recent
          ? <Clock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          : <Server className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
        <span className="truncate flex-1">{s.name}</span>
        {host && <span className="text-[10px] text-slate-500 font-mono truncate max-w-[110px]">{host}</span>}
      </button>
    );
  };

  const firstSession = items.findIndex(it => it.kind === 'session' && !it.recent);
  const firstRecent = items.findIndex(it => it.kind === 'session' && it.recent);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Open a tab"
      style={{ top: anchor.top, left: Math.max(8, Math.min(anchor.left, window.innerWidth - 296)) }}
      className="fixed z-50 w-72 bg-plinky-900 border border-plinky-700 rounded-lg shadow-2xl p-1.5 text-xs"
      onKeyDown={onKeyDown}
    >
      <div className="relative mb-1">
        <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Open a session…"
          className="w-full pl-6 pr-2 py-1 bg-plinky-950 border border-plinky-700 rounded text-slate-200 focus:outline-none focus:border-sky-500"
        />
      </div>
      <div role="listbox" className="max-h-80 overflow-y-auto space-y-0.5">
        {items.map((item, i) => (
          <React.Fragment key={i}>
            {i === firstRecent && <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-slate-500">Recent</div>}
            {i === firstSession && <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-slate-500">Sessions</div>}
            {item.kind === 'new' && <div className="border-t border-plinky-800 my-1" />}
            {row(item, i)}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
