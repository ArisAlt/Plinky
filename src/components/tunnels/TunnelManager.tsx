import React, { useState } from 'react';
import { TunnelEntry } from '../../types/session';
import { Network, Plus, ArrowRight, ShieldCheck, Power } from 'lucide-react';

interface TunnelManagerProps {
  sessionName: string;
}

export const TunnelManager: React.FC<TunnelManagerProps> = ({ sessionName }) => {
  const [tunnels, setTunnels] = useState<TunnelEntry[]>([
    {
      id: '1',
      type: 'Local',
      srcPort: 8080,
      destHost: 'localhost',
      destPort: 80,
      active: true,
      sessionName,
      bytesTransferred: 482910,
    },
    {
      id: '2',
      type: 'Dynamic',
      srcPort: 1080,
      active: true,
      sessionName,
      bytesTransferred: 1294820,
    },
    {
      id: '3',
      type: 'Remote',
      srcPort: 9000,
      destHost: '127.0.0.1',
      destPort: 3000,
      active: false,
      sessionName,
      bytesTransferred: 0,
    },
  ]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newType, setNewType] = useState<'Local' | 'Remote' | 'Dynamic'>('Local');
  const [newSrcPort, setNewSrcPort] = useState('5432');
  const [newDestHost, setNewDestHost] = useState('127.0.0.1');
  const [newDestPort, setNewDestPort] = useState('5432');

  const toggleTunnel = (id: string) => {
    setTunnels(prev =>
      prev.map(t => (t.id === id ? { ...t, active: !t.active } : t))
    );
  };

  const handleAddTunnel = () => {
    const entry: TunnelEntry = {
      id: Date.now().toString(),
      type: newType,
      srcPort: parseInt(newSrcPort, 10) || 8080,
      destHost: newType !== 'Dynamic' ? newDestHost : undefined,
      destPort: newType !== 'Dynamic' ? parseInt(newDestPort, 10) || 80 : undefined,
      active: true,
      sessionName,
      bytesTransferred: 0,
    };
    setTunnels(prev => [...prev, entry]);
    setShowAddModal(false);
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 KB';
    const mb = bytes / (1024 * 1024);
    return mb.toFixed(2) + ' MB';
  };

  return (
    <div className="flex flex-col h-full bg-plinky-950 text-slate-200 select-none text-xs">
      {/* Header */}
      <div className="flex items-center justify-between p-3 bg-plinky-900 border-b border-plinky-800">
        <div className="flex items-center space-x-2">
          <Network className="w-4 h-4 text-sky-400" />
          <span className="font-semibold text-slate-200">SSH Tunnels & Port Forwarding</span>
          <span className="text-slate-500 font-mono">({sessionName})</span>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center space-x-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium transition"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Forward</span>
        </button>
      </div>

      {/* Cards List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {tunnels.map((t) => (
          <div
            key={t.id}
            className={`p-3.5 rounded-lg border transition ${
              t.active
                ? 'bg-plinky-900/90 border-sky-500/40 shadow-sm shadow-sky-500/5'
                : 'bg-plinky-900/40 border-plinky-800 opacity-60'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${
                    t.type === 'Local'
                      ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                      : t.type === 'Dynamic'
                      ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                      : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  }`}
                >
                  {t.type} Forward ({t.type === 'Local' ? '-L' : t.type === 'Remote' ? '-R' : '-D'})
                </span>
                <span className="text-slate-400 text-xs">
                  {t.type === 'Dynamic' ? 'SOCKS5 Proxy' : 'TCP Tunnel'}
                </span>
              </div>

              <div className="flex items-center space-x-3">
                <span className="text-[11px] text-slate-400 font-mono">
                  {formatBytes(t.bytesTransferred || 0)} transferred
                </span>
                <button
                  onClick={() => toggleTunnel(t.id)}
                  title={t.active ? 'Disable Tunnel' : 'Enable Tunnel'}
                  className={`p-1 rounded transition ${
                    t.active
                      ? 'text-emerald-400 bg-emerald-500/20 hover:bg-emerald-500/30'
                      : 'text-slate-500 bg-slate-800 hover:text-slate-300'
                  }`}
                >
                  <Power className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Visual Node Connection Flow */}
            <div className="flex items-center space-x-3 mt-3 p-2 bg-plinky-950/80 rounded border border-plinky-800 font-mono text-xs">
              <div className="flex items-center space-x-1.5 text-slate-300">
                <span className="font-semibold text-sky-400">127.0.0.1:{t.srcPort}</span>
                <span className="text-[10px] text-slate-500">(Source)</span>
              </div>

              <ArrowRight className="w-3.5 h-3.5 text-slate-600" />

              <div className="flex items-center space-x-1 text-slate-400 px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 text-[11px]">
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                <span>SSH Pipe</span>
              </div>

              <ArrowRight className="w-3.5 h-3.5 text-slate-600" />

              <div className="flex items-center space-x-1.5 text-slate-300">
                {t.type === 'Dynamic' ? (
                  <span className="font-semibold text-purple-400">Dynamic Target Resolution</span>
                ) : (
                  <>
                    <span className="font-semibold text-emerald-400">{t.destHost}:{t.destPort}</span>
                    <span className="text-[10px] text-slate-500">(Remote)</span>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add Forward Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-plinky-900 border border-plinky-700 rounded-lg w-96 shadow-xl p-4 space-y-3">
            <h3 className="font-semibold text-slate-100 text-sm">Add SSH Port Forward</h3>
            
            <div className="space-y-1">
              <label className="text-slate-400 text-xs">Forward Type</label>
              <div className="grid grid-cols-3 gap-2">
                {(['Local', 'Remote', 'Dynamic'] as const).map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setNewType(type)}
                    className={`py-1 rounded text-xs border ${
                      newType === type
                        ? 'bg-sky-600 text-white border-sky-500'
                        : 'bg-plinky-950 text-slate-300 border-plinky-700 hover:border-slate-500'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-slate-400 text-xs">Listen / Source Port</label>
              <input
                type="number"
                value={newSrcPort}
                onChange={e => setNewSrcPort(e.target.value)}
                className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1 text-xs text-slate-200"
              />
            </div>

            {newType !== 'Dynamic' && (
              <>
                <div className="space-y-1">
                  <label className="text-slate-400 text-xs">Destination Host</label>
                  <input
                    type="text"
                    value={newDestHost}
                    onChange={e => setNewDestHost(e.target.value)}
                    className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1 text-xs text-slate-200"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 text-xs">Destination Port</label>
                  <input
                    type="number"
                    value={newDestPort}
                    onChange={e => setNewDestPort(e.target.value)}
                    className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1 text-xs text-slate-200"
                  />
                </div>
              </>
            )}

            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-3 py-1 rounded bg-plinky-800 text-slate-300 hover:bg-plinky-700 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={handleAddTunnel}
                className="px-3 py-1 rounded bg-sky-600 text-white hover:bg-sky-500 font-medium text-xs"
              >
                Create Tunnel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
