import React, { useEffect, useRef, useState } from 'react';

interface TabTitleProps {
  title: string;
  editing: boolean;
  onStartEdit: () => void;
  onCommit: (title: string) => void;
  onCancel: () => void;
}

/**
 * A tab's title, renamed in place (T-011): double-click (or the tab's
 * Rename menu item) to edit, Enter or leaving the field keeps it, Escape
 * throws it away. An empty name keeps the old one.
 */
export const TabTitle: React.FC<TabTitleProps> = ({ title, editing, onStartEdit, onCommit, onCancel }) => {
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (editing) {
      setDraft(title);
      done.current = false;
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [editing, title]);

  if (!editing) {
    return (
      <span className="truncate flex-1" onDoubleClick={e => { e.stopPropagation(); onStartEdit(); }} title="Double-click to rename">
        {title}
      </span>
    );
  }

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next && next !== title) onCommit(next);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      aria-label="Tab name"
      value={draft}
      maxLength={60}
      onChange={e => setDraft(e.target.value)}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') { done.current = true; onCancel(); }
      }}
      onBlur={commit}
      className="flex-1 min-w-0 w-28 bg-plinky-950 border border-sky-500 rounded px-1 text-xs text-slate-100 focus:outline-none"
    />
  );
};
