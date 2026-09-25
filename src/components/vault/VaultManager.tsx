import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  Lock, 
  Unlock, 
  Key, 
  Eye, 
  EyeOff, 
  Plus, 
  Trash2, 
  Copy, 
  Check, 
  RefreshCw, 
  AlertCircle,
  X
} from 'lucide-react';
import {
  VaultEntry,
  VaultEntryMeta,
  vaultIsInitialized,
  vaultIsUnlocked,
  vaultCreate,
  vaultUnlock,
  vaultLock,
  vaultListEntriesMeta,
  vaultGetEntry,
  vaultSetEntry,
  vaultDelete,
} from '../../services/tauriBridge';

// How long a copied secret is allowed to sit on the OS clipboard before it's
// cleared automatically -- common password-manager convention, limits how
// long a secret lingers somewhere clipboard history tools / other apps can
// read it from.
const CLIPBOARD_CLEAR_MS = 25_000;

interface VaultManagerProps {
  onClose?: () => void;
}

export const VaultManager: React.FC<VaultManagerProps> = ({ onClose }) => {
  const [isInitialized, setIsInitialized] = useState<boolean>(true);
  const [isUnlocked, setIsUnlocked] = useState<boolean>(false);
  const [masterPassword, setMasterPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Metadata only -- never holds a decrypted secret. Secrets are fetched
  // per-entry, on demand, only when the user explicitly reveals or copies
  // one (see revealedSecrets below), so an unlocked vault doesn't sit with
  // every stored credential's plaintext resident in JS memory at once.
  const [entries, setEntries] = useState<VaultEntryMeta[]>([]);
  // Holds a decrypted secret ONLY for entries the user has actually revealed,
  // keyed by entry id. Cleared for an entry the moment it's hidden again.
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [revealLoading, setRevealLoading] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // New entry form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newId, setNewId] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [newNotes, setNewNotes] = useState('');

  useEffect(() => {
    checkStatus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const checkStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const initialized = await vaultIsInitialized();
      setIsInitialized(initialized);
      if (initialized) {
        const unlocked = await vaultIsUnlocked();
        setIsUnlocked(unlocked);
        if (unlocked) {
          await loadEntries();
        }
      }
    } catch (e: any) {
      console.error(e);
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  };

  const loadEntries = async () => {
    try {
      // Metadata only -- no secrets are fetched or held here.
      const meta = await vaultListEntriesMeta();
      setEntries(meta);
      setRevealedSecrets({});
    } catch (e: any) {
      setError(e.toString());
    }
  };

  const handleCreateVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!masterPassword) {
      setError("Password cannot be empty");
      return;
    }
    if (masterPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (masterPassword.length < 8) {
      setError("Master password must be at least 8 characters");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await vaultCreate(masterPassword);
      setMasterPassword('');
      setConfirmPassword('');
      setIsInitialized(true);
      setIsUnlocked(true);
      await loadEntries();
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  };

  const handleUnlockVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!masterPassword) return;

    setLoading(true);
    setError(null);
    try {
      await vaultUnlock(masterPassword);
      setMasterPassword('');
      setIsUnlocked(true);
      await loadEntries();
    } catch (e: any) {
      setError("Failed to unlock vault. Incorrect master password or corrupted file.");
    } finally {
      setLoading(false);
    }
  };

  const handleLockVault = async () => {
    setLoading(true);
    try {
      await vaultLock();
      setIsUnlocked(false);
      setEntries([]);
      setRevealedSecrets({});
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  };

  const handleAddEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newId.trim() || !newSecret) {
      setError("Key name and secret are required");
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const entry: VaultEntry = {
      id: newId.trim(),
      username: newUsername.trim() || undefined,
      secret: newSecret,
      notes: newNotes.trim() || undefined,
      created_at: now,
      updated_at: now,
    };

    try {
      await vaultSetEntry(entry);
      setShowAddForm(false);
      setNewId('');
      setNewUsername('');
      setNewSecret('');
      setNewNotes('');
      await loadEntries();
    } catch (e: any) {
      setError(e.toString());
    }
  };

  const handleDeleteEntry = async (key: string) => {
    if (!confirm(`Are you sure you want to delete credential '${key}'?`)) return;
    try {
      await vaultDelete(key);
      await loadEntries();
    } catch (e: any) {
      setError(e.toString());
    }
  };

  // Fetches an entry's decrypted secret on demand and caches it, only for
  // as long as it stays revealed. Returns null (and surfaces an error) if
  // the fetch failed, so callers don't act on a stale/empty secret.
  const fetchSecret = async (key: string): Promise<string | null> => {
    if (revealedSecrets[key] !== undefined) return revealedSecrets[key];
    setRevealLoading(key);
    try {
      const entry: VaultEntry | null = await vaultGetEntry(key);
      if (!entry) {
        setError(`Credential '${key}' not found`);
        return null;
      }
      setRevealedSecrets(prev => ({ ...prev, [key]: entry.secret }));
      return entry.secret;
    } catch (e: any) {
      setError(e.toString());
      return null;
    } finally {
      setRevealLoading(null);
    }
  };

  const toggleReveal = async (key: string) => {
    if (revealedSecrets[key] !== undefined) {
      // Hide: actually drop the plaintext from state, don't just flip a flag.
      setRevealedSecrets(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    await fetchSecret(key);
  };

  const copyToClipboard = async (key: string) => {
    const secret = await fetchSecret(key);
    if (secret === null) return;
    navigator.clipboard.writeText(secret);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
    // Clear the clipboard after a timeout, but only if it still holds exactly
    // what we put there -- don't clobber something the user copied since.
    setTimeout(async () => {
      try {
        const current = await navigator.clipboard.readText();
        if (current === secret) {
          await navigator.clipboard.writeText('');
        }
      } catch {
        // Clipboard read permission can be denied by the browser/webview;
        // failing silently here is fine -- this is defense in depth, not
        // the primary protection.
      }
    }, CLIPBOARD_CLEAR_MS);
  };

  return (
    <div className="flex-1 bg-plinky-950 p-6 overflow-y-auto text-slate-200">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-plinky-800 pb-4">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-400">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white tracking-wide">Plinky Credential Vault</h1>
              <p className="text-xs text-slate-400">
                Argon2id (64 MiB, 3 iter) · AES-256-GCM authenticated container · In-memory Zeroize
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={checkStatus}
              title="Refresh Vault Status"
              className="p-2 rounded bg-plinky-900 border border-plinky-800 hover:border-plinky-700 text-slate-400 hover:text-white transition"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {isUnlocked && (
              <button
                onClick={handleLockVault}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-red-950/40 border border-red-800/50 hover:bg-red-900/50 text-red-300 text-xs transition"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Lock Vault</span>
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                title="Close Vault and return to Terminal (Esc)"
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-plinky-900 border border-plinky-800 hover:border-plinky-700 hover:bg-plinky-850 text-slate-300 hover:text-white text-xs transition ml-2"
              >
                <X className="w-4 h-4" />
                <span>Close</span>
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="p-3 rounded bg-red-950/30 border border-red-800/40 flex items-center space-x-2 text-xs text-red-300">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* View 1: Vault not initialized */}
        {!isInitialized ? (
          <div className="bg-plinky-900 border border-plinky-800 rounded-lg p-6 max-w-md mx-auto space-y-4">
            <div className="text-center space-y-1">
              <div className="mx-auto w-10 h-10 rounded-full bg-sky-500/20 flex items-center justify-center text-sky-400 mb-2">
                <Shield className="w-5 h-5" />
              </div>
              <h2 className="text-sm font-semibold text-white">Initialize Plinky Vault</h2>
              <p className="text-xs text-slate-400">
                Choose a strong master password to encrypt your session passwords and private keys.
              </p>
            </div>

            <form onSubmit={handleCreateVault} className="space-y-3 pt-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">Master Password</label>
                <input
                  type="password"
                  value={masterPassword}
                  onChange={e => setMasterPassword(e.target.value)}
                  placeholder="Enter strong master password..."
                  className="w-full px-3 py-2 bg-plinky-950 border border-plinky-700 rounded text-xs text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">Confirm Master Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Repeat master password..."
                  className="w-full px-3 py-2 bg-plinky-950 border border-plinky-700 rounded text-xs text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <button
                type="submit"
                disabled={loading || !masterPassword}
                className="w-full py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-medium text-xs rounded transition flex items-center justify-center space-x-1"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Create & Encrypt Vault</span>
              </button>
            </form>
          </div>
        ) : !isUnlocked ? (
          /* View 2: Vault is locked */
          <div className="bg-plinky-900 border border-plinky-800 rounded-lg p-6 max-w-md mx-auto space-y-4">
            <div className="text-center space-y-1">
              <div className="mx-auto w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 mb-2">
                <Lock className="w-5 h-5" />
              </div>
              <h2 className="text-sm font-semibold text-white">Unlock Vault</h2>
              <p className="text-xs text-slate-400">
                Enter your master password to decrypt your credential database.
              </p>
            </div>

            <form onSubmit={handleUnlockVault} className="space-y-3 pt-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">Master Password</label>
                <input
                  type="password"
                  value={masterPassword}
                  onChange={e => setMasterPassword(e.target.value)}
                  placeholder="Master password..."
                  autoFocus
                  className="w-full px-3 py-2 bg-plinky-950 border border-plinky-700 rounded text-xs text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <button
                type="submit"
                disabled={loading || !masterPassword}
                className="w-full py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-medium text-xs rounded transition flex items-center justify-center space-x-1"
              >
                <Unlock className="w-3.5 h-3.5" />
                <span>Unlock Credential Vault</span>
              </button>
            </form>
          </div>
        ) : (
          /* View 3: Vault is unlocked */
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-400">Stored Credentials:</span>
                <span className="text-xs font-mono font-medium text-sky-400 bg-sky-950/40 px-2 py-0.5 rounded border border-sky-800/40">
                  {entries.length} items
                </span>
              </div>

              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="flex items-center space-x-1 px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{showAddForm ? 'Cancel' : 'Add Credential'}</span>
              </button>
            </div>

            {/* Add Credential Form */}
            {showAddForm && (
              <form onSubmit={handleAddEntry} className="bg-plinky-900 border border-plinky-800 rounded-lg p-4 space-y-3">
                <h3 className="text-xs font-semibold text-white">Add New Credential</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Key / Session Identifier</label>
                    <input
                      type="text"
                      value={newId}
                      onChange={e => setNewId(e.target.value)}
                      placeholder="e.g. session:prod-web or server.internal"
                      className="w-full px-2.5 py-1.5 bg-plinky-950 border border-plinky-700 rounded text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Username (Optional)</label>
                    <input
                      type="text"
                      value={newUsername}
                      onChange={e => setNewUsername(e.target.value)}
                      placeholder="e.g. root or deploy"
                      className="w-full px-2.5 py-1.5 bg-plinky-950 border border-plinky-700 rounded text-xs text-white focus:outline-none focus:border-sky-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Secret / Password / Passphrase</label>
                  <input
                    type="password"
                    value={newSecret}
                    onChange={e => setNewSecret(e.target.value)}
                    placeholder="Enter secret..."
                    className="w-full px-2.5 py-1.5 bg-plinky-950 border border-plinky-700 rounded text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Notes (Optional)</label>
                  <input
                    type="text"
                    value={newNotes}
                    onChange={e => setNewNotes(e.target.value)}
                    placeholder="Production cluster primary database auth"
                    className="w-full px-2.5 py-1.5 bg-plinky-950 border border-plinky-700 rounded text-xs text-white focus:outline-none focus:border-sky-500"
                  />
                </div>

                <div className="flex justify-end space-x-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="px-3 py-1.5 rounded bg-plinky-800 text-slate-300 text-xs hover:bg-plinky-700 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition"
                  >
                    Save Secret
                  </button>
                </div>
              </form>
            )}

            {/* Credential List */}
            {entries.length === 0 ? (
              <div className="bg-plinky-900 border border-dashed border-plinky-800 rounded-lg p-8 text-center text-slate-500 text-xs">
                No credentials stored yet in this vault. Click "Add Credential" to save passwords or passphrases.
              </div>
            ) : (
              <div className="bg-plinky-900 border border-plinky-800 rounded-lg overflow-hidden divide-y divide-plinky-800">
                {entries.map(entry => {
                  const isRevealed = revealedSecrets[entry.id] !== undefined;
                  const isRevealPending = revealLoading === entry.id;
                  const isCopied = copiedKey === entry.id;

                  return (
                    <div key={entry.id} className="p-3 flex items-center justify-between hover:bg-plinky-850 transition">
                      <div className="space-y-0.5">
                        <div className="flex items-center space-x-2">
                          <Key className="w-3.5 h-3.5 text-sky-400" />
                          <span className="font-mono font-medium text-xs text-white">{entry.id}</span>
                          {entry.username && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-plinky-800 text-slate-400 font-mono">
                              {entry.username}
                            </span>
                          )}
                        </div>
                        {entry.notes && (
                          <p className="text-[11px] text-slate-400 pl-5">{entry.notes}</p>
                        )}
                        <div className="pl-5 pt-1 flex items-center space-x-2">
                          <span className="font-mono text-xs text-slate-300">
                            {isRevealPending
                              ? '…'
                              : isRevealed
                                ? revealedSecrets[entry.id]
                                : '••••••••••••••••'}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center space-x-1.5">
                        <button
                          onClick={() => toggleReveal(entry.id)}
                          title={isRevealed ? "Hide Secret" : "Reveal Secret"}
                          className="p-1.5 rounded hover:bg-plinky-800 text-slate-400 hover:text-slate-200 transition"
                        >
                          {isRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>

                        <button
                          onClick={() => copyToClipboard(entry.id)}
                          title="Copy Secret (clears clipboard after 25s)"
                          className="p-1.5 rounded hover:bg-plinky-800 text-slate-400 hover:text-slate-200 transition"
                        >
                          {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>

                        <button
                          onClick={() => handleDeleteEntry(entry.id)}
                          title="Delete Credential"
                          className="p-1.5 rounded hover:bg-red-950/60 text-slate-400 hover:text-red-400 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
