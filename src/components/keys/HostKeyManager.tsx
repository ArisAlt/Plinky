import React, { useEffect, useMemo, useState } from 'react';
import { HostKeyEntry, PpkInfo } from '../../types/session';
import { listPuttyHostKeys, inspectPpk, pickPpkFile, removePuttyHostKey } from '../../services/tauriBridge';
import { askConfirm } from '../../services/confirm';
import { Key, FileKey, Copy, Check, Upload, X, Search, Trash2 } from 'lucide-react';

interface HostKeyManagerProps {
  onClose?: () => void;
  /** Pre-fills the filter, e.g. after a changed-key warning for one host. */
  initialFilter?: string;
}

// PuTTY's cache names, as people know the algorithms.
const KEY_TYPE_LABEL: Record<string, string> = {
  rsa2: 'RSA',
  dss: 'DSA',
  'ssh-ed25519': 'Ed25519',
  'ssh-ed448': 'Ed448',
  'ecdsa-sha2-nistp256': 'ECDSA P-256',
  'ecdsa-sha2-nistp384': 'ECDSA P-384',
  'ecdsa-sha2-nistp521': 'ECDSA P-521',
};
export const keyTypeLabel = (t: string) => KEY_TYPE_LABEL[t] ?? t;

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

export const HostKeyManager: React.FC<HostKeyManagerProps> = ({ onClose, initialFilter = '' }) => {
  const [hostKeys, setHostKeys] = useState<HostKeyEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState(initialFilter);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [inspectedPpk, setInspectedPpk] = useState<PpkInfo | null>(null);
  const [ppkError, setPpkError] = useState<string | null>(null);

  useEffect(() => { setFilter(initialFilter); }, [initialFilter]);
  useEffect(() => { void loadKeys(); }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const loadKeys = async () => {
    try {
      setHostKeys(await listPuttyHostKeys());
      setLoadError(null);
    } catch (e) {
      setHostKeys([]);
      setLoadError(`Couldn't read PuTTY's host keys: ${String(e)}`);
    }
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = hostKeys ?? [];
    return q ? all.filter(k => `${k.hostname}:${k.port} ${keyTypeLabel(k.keyType)} ${k.fingerprint ?? ''}`.toLowerCase().includes(q)) : all;
  }, [hostKeys, filter]);

  const copyFingerprint = (fp: string) => {
    navigator.clipboard?.writeText(fp);
    setCopiedKey(fp);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const removeKey = async (hk: HostKeyEntry) => {
    const ok = await askConfirm({
      title: `Forget the ${keyTypeLabel(hk.keyType)} key for ${hk.hostname}:${hk.port}?`,
      body: 'PuTTY will ask again on the next connection. Do this only when you know why the key changed, and check the new fingerprint with the server\'s administrator.',
      confirmLabel: 'Forget key',
      danger: true,
    });
    if (!ok) return;
    try {
      await removePuttyHostKey(hk.keyType, hk.hostname, hk.port);
    } catch (e) {
      setLoadError(String(e));
    }
    await loadKeys();
  };

  const inspectKeyFile = async () => {
    setPpkError(null);
    const path = await pickPpkFile();
    if (!path) return;
    const info = await inspectPpk(path);
    if (info) setInspectedPpk(info);
    else setPpkError(`Not a PuTTY private key, or unreadable: ${path}`);
  };

  const count = hostKeys?.length ?? 0;

  return (
    <div className="flex flex-col h-full bg-plinky-950 text-slate-200 select-none text-xs p-4 space-y-4 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-plinky-800">
        <div className="flex items-center space-x-2">
          <Key className="w-4 h-4 text-slate-400" />
          <h2 className="font-semibold text-sm text-slate-100">Trusted host keys</h2>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={inspectKeyFile}
            className="flex items-center space-x-1 px-2.5 py-1 rounded border border-plinky-700 text-slate-300 hover:bg-plinky-800 transition"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Inspect a .ppk key…</span>
          </button>
          {onClose && (
            <button
              onClick={onClose}
              title="Close and return to Terminal (Esc)"
              className="p-1 rounded bg-plinky-900 border border-plinky-800 hover:border-plinky-700 hover:bg-plinky-850 text-slate-400 hover:text-white transition"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {ppkError && <div role="alert" className="p-2 rounded border border-rose-500/40 bg-rose-950/40 text-rose-300 text-meta">{ppkError}</div>}
      {inspectedPpk && (
        <div className="p-3.5 bg-plinky-900 border border-plinky-700 rounded-lg space-y-2">
          <div className="flex items-center space-x-2 text-slate-200 font-semibold text-xs">
            <FileKey className="w-4 h-4" />
            <span>{inspectedPpk.comment || inspectedPpk.path}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-300">
            <div>Format: <span className="text-slate-200 font-semibold">PPK v{inspectedPpk.version}</span></div>
            <div>Algorithm: <span className="font-mono text-slate-200">{inspectedPpk.algorithm}</span></div>
            <div>Passphrase: <span className="text-slate-200">{inspectedPpk.isEncrypted ? 'yes' : 'none'}</span></div>
            <div className="col-span-2 truncate">Fingerprint: <span className="font-mono text-slate-200 select-text">{inspectedPpk.fingerprintSha256}</span></div>
          </div>
        </div>
      )}

      {/* Host keys */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-slate-400 text-xs">
          <span>{isWindows ? 'From PuTTY’s store in the Windows registry' : 'From PuTTY’s store, ~/.putty/sshhostkeys'}</span>
          <span className="tabular-nums">{count} host {count === 1 ? 'key' : 'keys'}</span>
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-plinky-muted pointer-events-none" />
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            aria-label="Filter host keys"
            placeholder="Host, port, type or fingerprint"
            className="w-full pl-8 pr-3 py-1.5 bg-plinky-900 border border-plinky-700 rounded text-xs text-slate-200 placeholder-plinky-muted focus:outline-none focus:border-sky-500"
          />
        </div>
        {loadError && <div role="alert" className="p-2 rounded border border-rose-500/40 bg-rose-950/40 text-rose-300 text-meta">{loadError}</div>}

        {hostKeys !== null && count === 0 && !loadError ? (
          <div className="py-8 text-center text-slate-400">
            <p>No host keys yet.</p>
            <p className="text-meta text-plinky-muted mt-1">PuTTY saves a server's key the first time you trust it, and shows it here.</p>
          </div>
        ) : (
          <div className="border border-plinky-800 rounded-lg overflow-hidden bg-plinky-900/60">
            <table className="w-full text-left border-collapse">
              <thead className="bg-plinky-900 text-slate-400 text-meta border-b border-plinky-800">
                <tr>
                  <th className="py-2 px-3 font-medium">Host</th>
                  <th className="py-2 px-3 font-medium w-16">Port</th>
                  <th className="py-2 px-3 font-medium w-28">Type</th>
                  <th className="py-2 px-3 font-medium">SHA-256 fingerprint</th>
                  <th className="py-2 px-3 font-medium w-20 text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-plinky-800/60 text-xs">
                {shown.map(hk => (
                  <tr key={`${hk.keyType}@${hk.port}:${hk.hostname}`} className="hover:bg-plinky-800/40 transition">
                    <td className="py-2 px-3 font-mono font-medium text-slate-200">{hk.hostname}</td>
                    <td className="py-2 px-3 font-mono text-slate-400 tabular-nums">{hk.port}</td>
                    <td className="py-2 px-3 text-slate-300">{keyTypeLabel(hk.keyType)}</td>
                    <td className="py-2 px-3 font-mono text-slate-300 text-meta break-all select-text">
                      {hk.fingerprint ?? <span className="text-plinky-muted">Can't compute for this key type</span>}
                    </td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      {hk.fingerprint && (
                        <button
                          onClick={() => copyFingerprint(hk.fingerprint!)}
                          aria-label={`Copy fingerprint for ${hk.hostname}`}
                          className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-slate-200 transition"
                        >
                          {copiedKey === hk.fingerprint ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      <button
                        onClick={() => void removeKey(hk)}
                        aria-label={`Forget key for ${hk.hostname}:${hk.port}`}
                        className="p-1 rounded hover:bg-rose-500/10 text-slate-400 hover:text-rose-300 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && count > 0 && (
                  <tr><td colSpan={5} className="py-4 text-center text-slate-400">No key matches "{filter}".</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
