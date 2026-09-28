import React, { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, Eye } from 'lucide-react';
import {
  setPasteConfirmListener, setPasteConfirmMode, PasteRequest,
  pasteLineCount, endsWithLineBreak,
} from '../../services/pasteConfirm';

type Pending = PasteRequest & { resolve: (text: string | null) => void };

/** Draws askPaste() requests: the exact text about to be sent, editable.
 *  Paste has the focus, so Enter pastes (the window itself is the check);
 *  Escape cancels; Ctrl+Enter pastes from inside the text box. */
export const PasteConfirmHost: React.FC = () => {
  const [req, setReq] = useState<Pending | null>(null);
  const [text, setText] = useState('');
  const [reveal, setReveal] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const pasteRef = useRef<HTMLButtonElement>(null);
  // The key listener outlives renders; it reads the latest values here.
  const live = useRef({ req, text, dontAsk });
  live.current = { req, text, dontAsk };

  useEffect(() => setPasteConfirmListener(next => {
    live.current.req?.resolve(null); // a second paste replaces the first
    setReq(next);
    setText(next.text);
    setReveal(false);
    setDontAsk(false);
  }), []);

  const finish = (ok: boolean) => {
    const { req: r, text: t, dontAsk: d } = live.current;
    if (!r) return;
    if (ok && d) setPasteConfirmMode('never');
    r.resolve(ok && t ? t : null);
    setReq(null);
  };

  useEffect(() => {
    if (!req) return;
    const back = document.activeElement as HTMLElement | null;
    pasteRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      back?.focus?.();
    };
    // finish reads live.current; the listener only needs to follow req.
  }, [req]);

  if (!req) return null;
  const lines = pasteLineCount(text);
  const hidden = req.sensitive && !reveal;
  const paced = !!req.lineDelayMs && lines > 1;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-plinky-950/75 backdrop-blur-xs p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-title"
        aria-describedby="paste-summary"
        className="bg-plinky-900 border border-plinky-700 rounded-lg shadow-2xl max-w-2xl w-full p-5 text-slate-100"
      >
        <div className="flex items-start gap-3">
          <ClipboardPaste className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h3 id="paste-title" className="text-base font-semibold text-white break-words">
              {lines > 1 ? `Paste ${lines} lines into ${req.target}?` : `Paste into ${req.target}?`}
            </h3>
            <p id="paste-summary" className="text-xs text-slate-300 mt-1">
              {text.length} character{text.length === 1 ? '' : 's'}
              {paced && `, sent one line at a time, ${req.lineDelayMs} ms apart`}
            </p>
          </div>
        </div>

        {hidden ? (
          <div className="mt-3 flex items-center justify-between gap-3 bg-plinky-950 border border-plinky-800 rounded px-3 py-2.5">
            <div className="min-w-0">
              <div className="font-mono text-sm tracking-widest text-slate-200" aria-hidden="true">
                {'•'.repeat(Math.min(text.length, 24))}
              </div>
              <div className="text-meta text-plinky-muted mt-0.5">Hidden: the terminal is asking for a password.</div>
            </div>
            <button
              type="button"
              onClick={() => setReveal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-plinky-700 text-xs text-slate-200 hover:bg-plinky-800 outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <Eye className="w-3.5 h-3.5" /> Show
            </button>
          </div>
        ) : (
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            aria-label="Text to paste"
            spellCheck={false}
            wrap="off"
            // Every visible line, the empty one after a final line break
            // included, up to 14; beyond that the box scrolls.
            rows={Math.min(Math.max(text.split(/\r\n|\r|\n/).length, 3), 14)}
            className="mt-3 w-full resize-y font-mono text-xs leading-relaxed bg-plinky-950 border border-plinky-800 rounded px-3 py-2 text-slate-100 outline-none focus:border-sky-500/60 focus:ring-1 focus:ring-sky-500/40 overflow-auto"
          />
        )}

        {endsWithLineBreak(text) && (
          <p className="text-meta text-amber-300 mt-2">
            Ends with a line break: the last line runs as soon as it is pasted.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={e => setDontAsk(e.target.checked)}
              className="rounded border-plinky-700 bg-plinky-900 text-sky-500 focus:ring-0 cursor-pointer"
            />
            Don't ask again <span className="text-plinky-muted">(Settings turns it back on)</span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => finish(false)}
              className="px-3 py-1.5 rounded border border-plinky-700 text-slate-200 hover:bg-plinky-800 text-xs outline-none focus:ring-2 focus:ring-sky-400"
            >
              Cancel
            </button>
            <button
              ref={pasteRef}
              type="button"
              onClick={() => finish(true)}
              disabled={!text}
              className="px-3 py-1.5 rounded text-xs font-medium bg-sky-700 text-on-accent hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-plinky-900 focus-visible:ring-sky-300"
            >
              Paste
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
