import React, { useState, useEffect } from 'react';
import { PuttySession, Protocol } from '../../types/session';
import { 
  Terminal, X, Save, Key, Folder, Tag, Cpu, RefreshCw, 
  Shield, Server, Laptop, ArrowRight, ChevronDown, ChevronRight 
} from 'lucide-react';
import { listSerialPorts, DetectedSerialPort } from '../../services/tauriBridge';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (session: PuttySession) => void;
  editingSession?: PuttySession | null;
  savedSessions?: PuttySession[];
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  onClose,
  onSave,
  editingSession,
  savedSessions = [],
}) => {
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [port, setPort] = useState('22');
  const [protocol, setProtocol] = useState<Protocol>('SSH');
  const [username, setUsername] = useState('');
  const [folder, setFolder] = useState('Saved Sessions');
  const [tags, setTags] = useState('');
  const [publicKeyFile, setPublicKeyFile] = useState('');

  // Serial-specific state
  const [serialPorts, setSerialPorts] = useState<DetectedSerialPort[]>([]);
  const [isRefreshingPorts, setIsRefreshingPorts] = useState(false);
  const [serialLine, setSerialLine] = useState('');
  const [isCustomSerialLine, setIsCustomSerialLine] = useState(false);
  const [serialSpeed, setSerialSpeed] = useState('9600');
  const [serialDataBits, setSerialDataBits] = useState('8');
  const [serialStopBits, setSerialStopBits] = useState('2'); // 2 = 1 stop bit
  const [serialParity, setSerialParity] = useState('0'); // 0 = None
  const [serialFlowControl, setSerialFlowControl] = useState('1'); // 1 = XON/XOFF
  const [showAdvancedSerial, setShowAdvancedSerial] = useState(false);

  // Jump Host (MobaXterm style) state
  const [enableJumpHost, setEnableJumpHost] = useState(false);
  const [jumpHost, setJumpHost] = useState('');
  const [jumpPort, setJumpPort] = useState('22');
  const [jumpUsername, setJumpUsername] = useState('');

  const refreshPorts = async () => {
    setIsRefreshingPorts(true);
    try {
      const ports = await listSerialPorts();
      setSerialPorts(ports);
      if (ports.length > 0) {
        const firstUsb = ports.find(p => p.is_usb);
        // Functional update: by the time the scan returns, the session being
        // edited has loaded its saved line, but this closure still sees the
        // value from before -- testing that replaced the saved port with the
        // first one detected, and Save wrote it.
        setSerialLine(cur => cur || (firstUsb ?? ports[0]).port_name);
      }
    } finally {
      setIsRefreshingPorts(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    refreshPorts();
    if (editingSession) {
      setName(editingSession.name);
      setHostname(editingSession.hostname);
      setPort(String(editingSession.port || 22));
      setProtocol(editingSession.protocol);
      setUsername(editingSession.username || '');
      setFolder(editingSession.folder || 'Saved Sessions');
      setTags((editingSession.tags || []).join(', '));
      setPublicKeyFile(editingSession.publicKeyFile || '');

      // Load serial settings
      const extra = editingSession.extra || {};
      const line = extra.SerialLine || (editingSession.protocol === 'Serial' ? editingSession.hostname : '');
      setSerialLine(line);
      setSerialSpeed(extra.SerialSpeed || String(editingSession.port || 9600));
      setSerialDataBits(extra.SerialDataBits || '8');
      setSerialStopBits(extra.SerialStopHalfbits || '2');
      setSerialParity(extra.SerialParity || '0');
      setSerialFlowControl(extra.SerialFlowControl || '1');

      // Load jump host settings
      const hasJumpHost = extra.ProxyMethod === '5' || extra.PlinkyJumpHost === '1' || !!extra.ProxyHost;
      setEnableJumpHost(hasJumpHost);
      setJumpHost(extra.ProxyHost || '');
      setJumpPort(extra.ProxyPort || '22');
      setJumpUsername(extra.ProxyUsername || '');
    } else {
      setName('');
      setHostname('');
      setPort('22');
      setProtocol('SSH');
      setUsername('');
      setFolder('Saved Sessions');
      setTags('');
      setPublicKeyFile('');
      setSerialLine('');
      setIsCustomSerialLine(false);
      setSerialSpeed('9600');
      setSerialDataBits('8');
      setSerialStopBits('2');
      setSerialParity('0');
      setSerialFlowControl('1');
      setShowAdvancedSerial(false);
      setEnableJumpHost(false);
      setJumpHost('');
      setJumpPort('22');
      setJumpUsername('');
    }
  }, [isOpen, editingSession]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const isSerial = protocol === 'Serial';
    const tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);
    const extra: Record<string, string> = editingSession?.extra ? { ...editingSession.extra } : {};

    let finalHostname = hostname.trim();
    let finalPort = parseInt(port, 10) || 22;

    if (isSerial) {
      const activeLine = serialLine.trim() || '/dev/ttyUSB0';
      finalHostname = activeLine;
      finalPort = parseInt(serialSpeed, 10) || 9600;

      extra.SerialLine = activeLine;
      extra.SerialSpeed = serialSpeed || '9600';
      extra.SerialDataBits = serialDataBits || '8';
      extra.SerialStopHalfbits = serialStopBits || '2';
      extra.SerialParity = serialParity || '0';
      extra.SerialFlowControl = serialFlowControl || '1';
    } else {
      delete extra.SerialLine;
      delete extra.SerialSpeed;
      delete extra.SerialDataBits;
      delete extra.SerialStopHalfbits;
      delete extra.SerialParity;
      delete extra.SerialFlowControl;

      if (protocol === 'SSH' && enableJumpHost && jumpHost.trim()) {
        extra.ProxyMethod = '5';
        extra.ProxyHost = jumpHost.trim();
        extra.ProxyPort = jumpPort.trim() || '22';
        extra.ProxyUsername = jumpUsername.trim() || '';
        extra.ProxyTelnetCommand = 'plink -agent -P %proxyport %proxyuser@%proxyhost -nc %host:%port';
        extra.PlinkyJumpHost = '1';
      } else {
        delete extra.ProxyMethod;
        delete extra.ProxyHost;
        delete extra.ProxyPort;
        delete extra.ProxyUsername;
        delete extra.ProxyTelnetCommand;
        delete extra.PlinkyJumpHost;
      }
    }

    const session: PuttySession = {
      name: name.trim(),
      hostname: finalHostname,
      port: finalPort,
      protocol,
      username: isSerial ? undefined : (username.trim() || undefined),
      folder: folder.trim() || 'Saved Sessions',
      tags: tagArray.length > 0 ? tagArray : undefined,
      publicKeyFile: isSerial ? undefined : (publicKeyFile.trim() || undefined),
      extra,
      log_file_name: editingSession?.log_file_name,
      lastConnected: editingSession?.lastConnected,
    };

    onSave(session);
    onClose();
  };

  const isSerial = protocol === 'Serial';

  return (
    <div 
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none"
    >
      <div className="bg-plinky-900 border border-plinky-700 rounded-lg w-[500px] shadow-2xl flex flex-col overflow-hidden text-xs max-h-[90vh]">
        {/* Header */}
        <div className="p-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <Terminal className="w-4 h-4 text-sky-400" />
            <h3 className="font-semibold text-slate-100 text-sm">
              {editingSession ? `Edit "${editingSession.name}"` : 'New PuTTY Session'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3 overflow-y-auto flex-1">
          {/* Session Name */}
          <div className="space-y-1">
            <label className="text-slate-300 font-medium">Session Name *</label>
            <input
              type="text"
              required
              placeholder={isSerial ? 'e.g. Cisco Console Cable' : 'e.g. Production Web Server'}
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
            />
            {editingSession && name.trim() !== editingSession.name && (
              <p className="text-amber-400 text-[11px]">
                Changing the name saves this as a new session -- "{editingSession.name}" will still exist separately.
              </p>
            )}
          </div>

          {/* Protocol Selection */}
          <div className="space-y-1">
            <label className="text-slate-300 font-medium">Connection Protocol</label>
            <select
              value={protocol}
              onChange={e => {
                const nextProto = e.target.value as Protocol;
                setProtocol(nextProto);
                if (nextProto === 'Serial') {
                  if (serialPorts.length > 0 && !serialLine) {
                    const firstUsb = serialPorts.find(p => p.is_usb);
                    setSerialLine(firstUsb ? firstUsb.port_name : serialPorts[0].port_name);
                  }
                }
              }}
              className="w-full bg-plinky-950 border border-plinky-700 rounded px-2 py-1.5 text-slate-100 focus:outline-none focus:border-sky-500"
            >
              <option value="SSH">SSH (Secure Shell)</option>
              <option value="Serial">Serial (USB / COM Port)</option>
              <option value="Telnet">Telnet</option>
              <option value="Rlogin">Rlogin</option>
              <option value="RAW">RAW</option>
            </select>
          </div>

          {/* SERIAL PROTOCOL FIELDS */}
          {isSerial ? (
            <div className="p-3 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-3">
              <div className="flex items-center space-x-2 text-slate-300 font-medium pb-1 border-b border-plinky-800">
                <Cpu className="w-3.5 h-3.5 text-amber-400" />
                <span>Serial Port & Hardware Line Settings</span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-slate-300 text-[11px]">Serial Line (COM / USB Port) *</label>
                    <button
                      type="button"
                      onClick={refreshPorts}
                      title="Scan for plugged-in USB and serial devices"
                      className="text-slate-400 hover:text-sky-400 flex items-center space-x-1 text-[10px] transition"
                    >
                      <RefreshCw className={`w-2.5 h-2.5 ${isRefreshingPorts ? 'animate-spin text-sky-400' : ''}`} />
                      <span>Refresh</span>
                    </button>
                  </div>
                  {isCustomSerialLine ? (
                    <div className="flex items-center space-x-1">
                      <input
                        type="text"
                        required
                        placeholder="/dev/ttyUSB0 or COM3"
                        value={serialLine}
                        onChange={e => setSerialLine(e.target.value)}
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                      />
                      <button
                        type="button"
                        onClick={() => setIsCustomSerialLine(false)}
                        className="px-2 py-1 rounded bg-plinky-800 text-slate-300 hover:bg-plinky-700 text-[10px]"
                      >
                        List
                      </button>
                    </div>
                  ) : (
                    <select
                      value={serialLine}
                      onChange={e => {
                        if (e.target.value === '__custom__') {
                          setIsCustomSerialLine(true);
                        } else {
                          setSerialLine(e.target.value);
                        }
                      }}
                      className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                    >
                      {/* Every detected port is plugged in right now (●). A
                          saved port that isn't gets its own entry (○): with
                          no matching option the select showed some other
                          port while still saving this one. */}
                      {serialLine && !serialPorts.some(p => p.port_name === serialLine) && (
                        <option value={serialLine}>{`○ ${serialLine} (not connected)`}</option>
                      )}
                      {serialPorts.length === 0 ? (
                        <option value="" disabled>No serial devices detected</option>
                      ) : (
                        serialPorts.map(p => (
                          <option key={p.port_name} value={p.port_name}>
                            {`● ${p.display_name}`}
                          </option>
                        ))
                      )}
                      <option value="__custom__">Manual path / Custom COM port...</option>
                    </select>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-slate-300 text-[11px]">Speed (Baud)</label>
                  <select
                    value={serialSpeed}
                    onChange={e => setSerialSpeed(e.target.value)}
                    className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                  >
                    <option value="9600">9600</option>
                    <option value="19200">19200</option>
                    <option value="38400">38400</option>
                    <option value="57600">57600</option>
                    <option value="115200">115200 (Network)</option>
                    <option value="230400">230400</option>
                    <option value="921600">921600</option>
                  </select>
                </div>
              </div>

              {/* Collapsible Advanced Serial */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvancedSerial(v => !v)}
                  className="flex items-center space-x-1 text-[11px] text-slate-400 hover:text-slate-200 transition"
                >
                  {showAdvancedSerial ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <span>Advanced Serial Parameters (Data/Stop bits, Parity, Flow Control)</span>
                </button>

                {showAdvancedSerial && (
                  <div className="grid grid-cols-4 gap-2 pt-2 animate-in fade-in duration-100">
                    <div className="space-y-1">
                      <label className="text-slate-400 text-[10px]">Data Bits</label>
                      <select
                        value={serialDataBits}
                        onChange={e => setSerialDataBits(e.target.value)}
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-1.5 py-0.5 text-slate-200 text-xs"
                      >
                        <option value="8">8</option>
                        <option value="7">7</option>
                        <option value="6">6</option>
                        <option value="5">5</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-slate-400 text-[10px]">Stop Bits</label>
                      <select
                        value={serialStopBits}
                        onChange={e => setSerialStopBits(e.target.value)}
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-1.5 py-0.5 text-slate-200 text-xs"
                      >
                        <option value="2">1</option>
                        <option value="4">2</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-slate-400 text-[10px]">Parity</label>
                      <select
                        value={serialParity}
                        onChange={e => setSerialParity(e.target.value)}
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-1.5 py-0.5 text-slate-200 text-xs"
                      >
                        <option value="0">None</option>
                        <option value="1">Odd</option>
                        <option value="2">Even</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-slate-400 text-[10px]">Flow Control</label>
                      <select
                        value={serialFlowControl}
                        onChange={e => setSerialFlowControl(e.target.value)}
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-1.5 py-0.5 text-slate-200 text-xs"
                      >
                        <option value="0">None</option>
                        <option value="1">XON/XOFF</option>
                        <option value="2">RTS/CTS</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* NETWORK PROTOCOL FIELDS (SSH / Telnet / RAW / Rlogin) */
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-1">
                  <label className="text-slate-300 font-medium">Host Name or IP Address *</label>
                  <input
                    type="text"
                    required
                    placeholder="192.0.2.10 or router.internal"
                    value={hostname}
                    onChange={e => setHostname(e.target.value)}
                    className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-300 font-medium">Port</label>
                  <input
                    type="number"
                    value={port}
                    onChange={e => setPort(e.target.value)}
                    className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-slate-300 font-medium">Default Username</label>
                <input
                  type="text"
                  placeholder="e.g. root, admin, or deploy"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                />
              </div>

              {protocol === 'SSH' && (
                <div className="space-y-1">
                  <label className="text-slate-300 font-medium flex items-center space-x-1">
                    <Key className="w-3.5 h-3.5 text-amber-400" />
                    <span>Private Key File (.ppk)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="/path/to/key.ppk (or Pageant/agent will handle auth)"
                    value={publicKeyFile}
                    onChange={e => setPublicKeyFile(e.target.value)}
                    className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
              )}
            </>
          )}

          {/* MOBAXTERM-STYLE JUMP HOST / SSH GATEWAY (SSH Only) */}
          {protocol === 'SSH' && (
            <div className="p-3 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableJumpHost}
                    onChange={e => setEnableJumpHost(e.target.checked)}
                    className="rounded border-plinky-700 text-sky-500 focus:ring-0 bg-plinky-900"
                  />
                  <span className="text-slate-200 font-medium flex items-center space-x-1.5">
                    <Shield className="w-3.5 h-3.5 text-sky-400" />
                    <span>Connect through SSH Jump Host (Gateway / Bastion)</span>
                  </span>
                </label>
              </div>

              {enableJumpHost && (
                <div className="space-y-2.5 pt-1 border-t border-plinky-800/80 animate-in fade-in duration-150">
                  {/* Visual Topology Route Banner (MobaXterm Style) */}
                  <div className="p-2 rounded bg-plinky-900/90 border border-sky-500/30 flex items-center justify-between text-[11px]">
                    <div className="flex items-center space-x-1">
                      <Laptop className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="text-slate-400 font-mono">Client</span>
                    </div>
                    <div className="flex items-center space-x-1 text-slate-500">
                      <div className="h-px w-4 bg-sky-500/50" />
                      <span className="text-[9px] text-sky-400 uppercase font-semibold">SSH</span>
                      <ArrowRight className="w-3 h-3 text-sky-400" />
                    </div>
                    <div className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-sky-950/80 border border-sky-500/50">
                      <Shield className="w-3 h-3 text-amber-400 shrink-0" />
                      <span className="text-amber-300 font-mono font-medium truncate max-w-[120px]" title={jumpHost || 'Jump Host'}>
                        {jumpHost.trim() ? (jumpUsername ? `${jumpUsername}@${jumpHost}` : jumpHost) : 'Bastion'}
                      </span>
                    </div>
                    <div className="flex items-center space-x-1 text-slate-500">
                      <div className="h-px w-4 bg-emerald-500/50" />
                      <span className="text-[9px] text-emerald-400 uppercase font-semibold">SSH</span>
                      <ArrowRight className="w-3 h-3 text-emerald-400" />
                    </div>
                    <div className="flex items-center space-x-1">
                      <Server className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="text-emerald-300 font-mono font-medium truncate max-w-[110px]" title={hostname || 'Target'}>
                        {hostname.trim() || 'Target'}
                      </span>
                    </div>
                  </div>

                  {/* Preset from existing saved sessions */}
                  {savedSessions.length > 0 && (
                    <div className="space-y-1">
                      <label className="text-slate-400 text-[10px]">Populate from Saved Session</label>
                      <select
                        onChange={e => {
                          const sess = savedSessions.find(s => s.name === e.target.value);
                          if (sess) {
                            setJumpHost(sess.hostname);
                            setJumpPort(String(sess.port || 22));
                            if (sess.username) setJumpUsername(sess.username);
                          }
                        }}
                        defaultValue=""
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-200 text-xs focus:outline-none focus:border-sky-500"
                      >
                        <option value="" disabled>-- Select a saved bastion host --</option>
                        {savedSessions.filter(s => s.protocol === 'SSH' && s.name !== name).map(s => (
                          <option key={s.name} value={s.name}>
                            {s.name} ({s.hostname}:{s.port})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2 space-y-1">
                      <label className="text-slate-300 text-[11px]">Jump Host / Gateway IP *</label>
                      <input
                        type="text"
                        required={enableJumpHost}
                        placeholder="bastion.internal or jump.corp.com"
                        value={jumpHost}
                        onChange={e => setJumpHost(e.target.value)}
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-slate-300 text-[11px]">Port</label>
                      <input
                        type="number"
                        value={jumpPort}
                        onChange={e => setJumpPort(e.target.value)}
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-slate-300 text-[11px]">Gateway Username</label>
                    <input
                      type="text"
                      placeholder="bastion_user (or leave blank if same)"
                      value={jumpUsername}
                      onChange={e => setJumpUsername(e.target.value)}
                      className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Organization & Tags */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium flex items-center space-x-1">
                <Folder className="w-3.5 h-3.5 text-sky-400" />
                <span>Folder Category</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Staging or Network"
                value={folder}
                onChange={e => setFolder(e.target.value)}
                className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-300 font-medium flex items-center space-x-1">
                <Tag className="w-3.5 h-3.5 text-emerald-400" />
                <span>Tags (comma-separated)</span>
              </label>
              <input
                type="text"
                placeholder="cisco, core, serial, lab"
                value={tags}
                onChange={e => setTags(e.target.value)}
                className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-2 pt-3 border-t border-plinky-800 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded bg-plinky-800 text-slate-300 hover:bg-plinky-700 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium shadow-sm transition"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{editingSession ? 'Save Changes' : 'Save PuTTY Session'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
