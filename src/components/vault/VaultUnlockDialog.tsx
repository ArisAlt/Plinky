import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';
import { vaultUnlock } from '../../services/tauriBridge';

interface Props {
  /** What the unlock is for, in a sentence ("to save this session's password"). */
  reason: string;
  onUnlocked: () => void;
  onCancel: () => void;
}

// Asked for in place. A locked vault used to leave the session dialog with a
// note to go to "Vault in the top bar", which meant closing the dialog and
// losing what was typed into it.
export const VaultUnlockDialog: React.FC<Props> = ({ reason, onUnlocked, onCancel }) => {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Escape closes this, not the dialog underneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vaultUnlock(password);
      setPassword('');
      onUnlocked();
    } catch {
      setError('That master password did not unlock the vault.');
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  // A portal: this opens from inside the session form, and a form can't
  // hold another form.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-plinky-950/75 backdrop-blur-xs p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-unlock-title"
        onSubmit={submit}
        className="bg-plinky-900 border border-plinky-700 rounded-lg shadow-2xl max-w-sm w-full p-5 text-slate-100 space-y-3"
      >
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0">
            <h3 id="vault-unlock-title" className="text-base font-semibold text-white">Unlock the vault</h3>
            <p className="text-xs text-slate-300 mt-1 leading-relaxed">{reason}</p>
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="vault-unlock-password" className="text-slate-300 text-meta">Master password</label>
          <input
            id="vault-unlock-password"
            ref={inputRef}
            type="password"
            autoComplete="off"
            value={password}
            onChange={e => setPassword(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? 'vault-unlock-error' : undefined}
            className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
          />
          {error && <p id="vault-unlock-error" role="alert" className="text-rose-300 text-meta">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded border border-plinky-700 text-slate-200 hover:bg-plinky-800 text-xs"
          >
            Not now
          </button>
          <button
            type="submit"
            disabled={!password || busy}
            className="px-3 py-1.5 rounded bg-sky-700 text-on-accent text-xs font-medium hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};
