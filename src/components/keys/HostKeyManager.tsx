import React, { useEffect, useState } from 'react';
import { HostKeyEntry, PpkInfo } from '../../types/session';
import { listPuttyHostKeys, inspectPpk } from '../../services/tauriBridge';
import { Key, FileKey, Copy, Check, Upload } from 'lucide-react';

export const HostKeyManager: React.FC = () => {
  const [hostKeys, setHostKeys] = useState<HostKeyEntry[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [inspectedPpk, setInspectedPpk] = useState<PpkInfo | null>(null);

  useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    const keys = await listPuttyHostKeys();
    setHostKeys(keys);
  };

  const copyFingerprint = (fp: string) => {
    navigator.clipboard.writeText(fp);
    setCopiedKey(fp);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const handleSimulateInspectKey = async () => {
    const info = await inspectPpk('/path/to/id_ed25519.ppk');
    setInspectedPpk(info);
  };

  return (
    <div className="flex flex-col h-full bg-plinky-950 text-slate-200 select-none text-xs p-4 space-y-4 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-plinky-800">
        <div className="flex items-center space-x-2">
          <Key className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-sm text-slate-100">PuTTY Trusted Host Keys & PPK Manager</h2>
        </div>
        <button
          onClick={handleSimulateInspectKey}
          className="flex items-center space-x-1 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium transition"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Inspect .ppk Key</span>
        </button>
      </div>

      {/* Inspected PPK Banner if any */}
      {inspectedPpk && (
        <div className="p-3.5 bg-plinky-900 border border-amber-500/40 rounded-lg space-y-2">
          <div className="flex items-center space-x-2 text-amber-300 font-semibold text-xs">
            <FileKey className="w-4 h-4" />
            <span>PPK Header Verified: {inspectedPpk.comment}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs font-mono text-slate-300">
            <div>Format Version: <span className="text-amber-400 font-bold">v{inspectedPpk.version}</span></div>
            <div>Algorithm: <span className="text-sky-400">{inspectedPpk.algorithm}</span></div>
            <div>Encryption: <span className="text-slate-400">{inspectedPpk.isEncrypted ? 'Argon2id' : 'None'}</span></div>
            <div className="col-span-2 truncate">Fingerprint: <span className="text-emerald-400">{inspectedPpk.fingerprintSha256}</span></div>
          </div>
        </div>
      )}

      {/* Host Keys Table */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-slate-400 text-xs">
          <span>Trusted Servers from PuTTY Store (~/.putty/sshhostkeys / WinReg)</span>
          <span className="font-mono">{hostKeys.length} host keys</span>
        </div>

        <div className="border border-plinky-800 rounded-lg overflow-hidden bg-plinky-900/60">
          <table className="w-full text-left border-collapse">
            <thead className="bg-plinky-900 text-slate-400 text-[11px] border-b border-plinky-800">
              <tr>
                <th className="py-2 px-3 font-medium">Hostname</th>
                <th className="py-2 px-3 font-medium w-16">Port</th>
                <th className="py-2 px-3 font-medium w-28">Key Type</th>
                <th className="py-2 px-3 font-medium">SHA256 Fingerprint</th>
                <th className="py-2 px-3 font-medium w-16 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-plinky-800/60 font-mono text-xs">
              {hostKeys.map((hk, idx) => (
                <tr key={idx} className="hover:bg-plinky-800/40 transition">
                  <td className="py-2 px-3 font-medium text-slate-200">{hk.hostname}</td>
                  <td className="py-2 px-3 text-slate-400">{hk.port}</td>
                  <td className="py-2 px-3 text-sky-400 text-[11px]">{hk.keyType}</td>
                  <td className="py-2 px-3 text-emerald-400 text-[11px] truncate max-w-xs">
                    {hk.fingerprint || 'Verified in PuTTY store'}
                  </td>
                  <td className="py-2 px-3 text-center">
                    {hk.fingerprint && (
                      <button
                        onClick={() => copyFingerprint(hk.fingerprint!)}
                        title="Copy Fingerprint"
                        className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-slate-200 transition"
                      >
                        {copiedKey === hk.fingerprint ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
