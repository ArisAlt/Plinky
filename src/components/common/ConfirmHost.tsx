import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { setConfirmListener, ConfirmRequest } from '../../services/confirm';

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };

/** Draws askConfirm() requests. Cancel has the focus, and Escape cancels:
 *  a stray Enter must never be the thing that deletes. */
export const ConfirmHost: React.FC = () => {
  const [req, setReq] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reqRef = useRef<Pending | null>(null);
  reqRef.current = req;

  useEffect(() => setConfirmListener(next => {
    reqRef.current?.resolve(false); // a second request replaces the first
    setReq(next);
  }), []);

  const answer = (ok: boolean) => {
    req?.resolve(ok);
    setReq(null);
  };

  useEffect(() => {
    if (!req) return;
    const back = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        reqRef.current?.resolve(false);
        setReq(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      back?.focus?.();
    };
  }, [req]);

  if (!req) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-plinky-950/75 backdrop-blur-xs p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={req.body ? 'confirm-body' : undefined}
        className={`bg-plinky-900 border rounded-lg shadow-2xl max-w-md w-full p-5 text-slate-100 ${req.danger ? 'border-rose-500/60' : 'border-plinky-700'}`}
      >
        <div className="flex items-start gap-3">
          {req.danger && <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />}
          <div className="min-w-0">
            <h3 id="confirm-title" className="text-base font-semibold text-white break-words">{req.title}</h3>
            {req.body && <p id="confirm-body" className="text-xs text-slate-300 mt-1.5 leading-relaxed">{req.body}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button
            ref={cancelRef}
            onClick={() => answer(false)}
            className="px-3 py-1.5 rounded border border-plinky-700 text-slate-200 hover:bg-plinky-800 text-xs outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            Cancel
          </button>
          <button
            onClick={() => answer(true)}
            className={`px-3 py-1.5 rounded text-xs font-medium text-white hover:brightness-110 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-plinky-900 ${
              req.danger ? 'bg-rose-700 focus-visible:ring-rose-300' : 'bg-sky-700 focus-visible:ring-sky-300'
            }`}
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
