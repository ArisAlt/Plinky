import React, { useState, useEffect } from 'react';
import { PuttySession, Protocol } from '../../types/session';
import { 
  Terminal, X, Save, Key, Folder, Tag, Cpu, RefreshCw, 
  Shield, Server, Laptop, ArrowRight, ChevronDown, ChevronRight, Lock 
} from 'lucide-react';
import { 
  listSerialPorts, DetectedSerialPort, 
  vaultListEntriesMeta, vaultSetEntry, VaultEntryMeta, VaultEntry,
  VAULT_CHANGED_EVENT,
} from '../../services/tauriBridge';
import { SESSION_SAVED_EVENT, SessionSavedDetail, MAX_PASTE_LINE_DELAY_MS, pasteLineDelayFrom } from '../../services/appEvents';

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

  // Encrypted Vault credentials state
  const [useVault, setUseVault] = useState(false);
  const [vaultMode, setVaultMode] = useState<'new' | 'link'>('new');
  const [vaultEntries, setVaultEntries] = useState<VaultEntryMeta[]>([]);
  const [selectedVaultKey, setSelectedVaultKey] = useState('');
  const [vaultKeyId, setVaultKeyId] = useState('');
  const [vaultPassword, setVaultPassword] = useState('');
  const [isNetworkDevice, setIsNetworkDevice] = useState(false);
  const [vaultEnablePassword, setVaultEnablePassword] = useState('');
  const [vaultSaveError, setVaultSaveError] = useState<string | null>(null);
  // Automatic answers from the vault (owner decision: opt-in per session).
  const [autoEnable, setAutoEnable] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);
  // Paste line delay in ms ('' or 0 = paste normally).
  const [pasteDelay, setPasteDelay] = useState('');

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
  // A saved session picked as the bastion: stored by name, so plink uses
  // that session's own host, port, username and key file (tested against a
  // real bastion/target pair with no agent running).
  const [jumpPreset, setJumpPreset] = useState<string | null>(null);

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
    setVaultSaveError(null);
    vaultListEntriesMeta().then(setVaultEntries).catch(() => {});
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
      // Only Plinky's own jump host (or PuTTY's SSH proxy type) counts. Any
      // ProxyHost used to, so an HTTP/SOCKS proxy set up in real PuTTY showed
      // up here and was rewritten as a jump host on save.
      const hasJumpHost = extra.PlinkyJumpHost === '1' || extra.ProxyMethod === '6';
      const preset = hasJumpHost ? savedSessions.find(s => s.name === extra.ProxyHost) : undefined;
      setEnableJumpHost(hasJumpHost);
      setJumpPreset(preset ? preset.name : null);
      setJumpHost(hasJumpHost ? (preset ? preset.hostname : extra.ProxyHost || '') : '');
      setJumpPort(hasJumpHost ? (preset ? String(preset.port || 22) : extra.ProxyPort || '22') : '22');
      setJumpUsername(hasJumpHost ? (preset ? preset.username || '' : extra.ProxyUsername || '') : '');

      // Load vault credentials key
      if (extra.PlinkyVaultKey) {
        setUseVault(true);
        setVaultMode('link');
        setSelectedVaultKey(extra.PlinkyVaultKey);
        setVaultKeyId(extra.PlinkyVaultKey);
      } else {
        setUseVault(false);
        setVaultMode('new');
        setSelectedVaultKey('');
        setVaultKeyId(`session:${editingSession.name}`);
      }
      setVaultPassword('');
      setIsNetworkDevice(false);
      setVaultEnablePassword('');
      setAutoEnable(extra.PlinkyAutoEnable === '1');
      setAutoLogin(extra.PlinkyAutoLogin === '1');
      const delay = pasteLineDelayFrom(extra);
      setPasteDelay(delay ? String(delay) : '');
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
      setJumpPreset(null);
      setUseVault(false);
      setVaultMode('new');
      setSelectedVaultKey('');
      setVaultKeyId('');
      setVaultPassword('');
      setIsNetworkDevice(false);
      setVaultEnablePassword('');
      setAutoEnable(false);
      setAutoLogin(false);
      setPasteDelay('');
    }
  }, [isOpen, editingSession]);

  // Unlocking the vault with this dialog open fills "Link to existing".
  useEffect(() => {
    if (!isOpen) return;
    const reload = () => { vaultListEntriesMeta().then(setVaultEntries).catch(() => setVaultEntries([])); };
    window.addEventListener(VAULT_CHANGED_EVENT, reload);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, reload);
  }, [isOpen]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setVaultSaveError(null);

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

      // PuTTY's own SSH proxy (ProxyMethod 6): plink connects to the bastion
      // itself and forwards to the target, asking about each host key in
      // turn. The previous local-command proxy (5) never worked: it used
      // "%proxyuser", which PuTTY doesn't substitute (it's %user), so every
      // bastion login was as the literal user "%proxyuser".
      const wasJumpHost = editingSession?.extra?.PlinkyJumpHost === '1' || editingSession?.extra?.ProxyMethod === '6';
      if (protocol === 'SSH' && enableJumpHost && (jumpPreset || jumpHost.trim())) {
        extra.ProxyMethod = '6';
        extra.ProxyHost = jumpPreset ?? jumpHost.trim();
        extra.ProxyPort = jumpPort.trim() || '22';
        if (jumpPreset) delete extra.ProxyUsername; // the saved session's own user applies
        else extra.ProxyUsername = jumpUsername.trim();
        delete extra.ProxyTelnetCommand;
        extra.PlinkyJumpHost = '1';
      } else if (wasJumpHost) {
        // Only undo Plinky's own jump host; a PuTTY proxy stays as it was.
        delete extra.ProxyMethod;
        delete extra.ProxyHost;
        delete extra.ProxyPort;
        delete extra.ProxyUsername;
        delete extra.ProxyTelnetCommand;
        delete extra.PlinkyJumpHost;
      }
    }

    // Encrypted Vault Credential Binding
    if (useVault) {
      if (vaultMode === 'link' && selectedVaultKey) {
        extra.PlinkyVaultKey = selectedVaultKey;
      } else if (vaultMode === 'new') {
        const finalKeyId = vaultKeyId.trim() || `session:${name.trim()}`;
        if (vaultPassword) {
          const now = Math.floor(Date.now() / 1000);
          const entry: VaultEntry = {
            id: finalKeyId,
            username: isSerial ? undefined : (username.trim() || undefined),
            secret: vaultPassword,
            // Never trimmed: a password with a leading or trailing space is
            // a different password.
            enable_secret: isNetworkDevice && vaultEnablePassword ? vaultEnablePassword : undefined,
            notes: `Saved credentials for session "${name.trim()}"`,
            created_at: now,
            updated_at: now,
          };
          // This failed silently when the vault was locked: the dialog
          // closed, the session was linked to an entry that didn't exist,
          // and the password was simply gone. Stay open and say why.
          try {
            await vaultSetEntry(entry);
          } catch (err) {
            setVaultSaveError(`The password wasn't saved: ${String(err)}. Unlock the vault (Vault in the top bar), then save again.`);
            return;
          }
          extra.PlinkyVaultKey = finalKeyId;
        } else if (vaultEntries.some(v => v.id === finalKeyId)) {
          extra.PlinkyVaultKey = finalKeyId;
        } else {
          // Linking to an entry that doesn't exist left a dangling key.
          setVaultSaveError('Enter the password to save in the vault, or untick "Save Credentials in Encrypted Vault".');
          return;
        }
      }
    } else {
      delete extra.PlinkyVaultKey;
    }

    if (autoEnable) extra.PlinkyAutoEnable = '1'; else delete extra.PlinkyAutoEnable;
    const pasteLineDelayMs = pasteLineDelayFrom({ PlinkyPasteLineDelayMs: pasteDelay });
    if (pasteLineDelayMs > 0) extra.PlinkyPasteLineDelayMs = String(pasteLineDelayMs);
    else delete extra.PlinkyPasteLineDelayMs;
    if (autoLogin && (protocol === 'Telnet' || protocol === 'Serial')) extra.PlinkyAutoLogin = '1';
    else delete extra.PlinkyAutoLogin;

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
    // Open terminals of this session apply the new delay right away.
    window.dispatchEvent(new CustomEvent<SessionSavedDetail>(SESSION_SAVED_EVENT, {
      detail: { name: session.name, pasteLineDelayMs },
    }));
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
                            setJumpPreset(sess.name);
                            setJumpHost(sess.hostname);
                            setJumpPort(String(sess.port || 22));
                            setJumpUsername(sess.username || '');
                          }
                        }}
                        value={jumpPreset ?? ''}
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
                        onChange={e => { setJumpPreset(null); setJumpHost(e.target.value); }}
                        className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-slate-300 text-[11px]">Port</label>
                      <input
                        type="number"
                        value={jumpPort}
                        onChange={e => { setJumpPreset(null); setJumpPort(e.target.value); }}
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
                      onChange={e => { setJumpPreset(null); setJumpUsername(e.target.value); }}
                      className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ENCRYPTED VAULT CREDENTIALS SECTION */}
          <div className="p-3 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useVault}
                  onChange={e => setUseVault(e.target.checked)}
                  className="rounded border-plinky-700 text-sky-500 focus:ring-0 bg-plinky-900"
                />
                <span className="text-slate-200 font-medium flex items-center space-x-1.5">
                  <Lock className="w-3.5 h-3.5 text-amber-400" />
                  <span>Save Credentials in Encrypted Vault</span>
                </span>
              </label>
              {useVault && (
                <span className="text-[10px] text-slate-400 font-mono">
                  Argon2id + AES-256-GCM
                </span>
              )}
            </div>

            {useVault && (
              <div className="space-y-2.5 pt-1 border-t border-plinky-800/80 animate-in fade-in duration-150">
                {/* Mode toggle: Create New vs Link Existing */}
                <div className="flex items-center space-x-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setVaultMode('new')}
                    className={`flex-1 py-1 px-2 rounded border text-center font-medium transition ${
                      vaultMode === 'new'
                        ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
                        : 'bg-plinky-900 text-slate-400 border-plinky-700 hover:text-slate-300'
                    }`}
                  >
                    Create New Vault Entry
                  </button>
                  <button
                    type="button"
                    onClick={() => setVaultMode('link')}
                    className={`flex-1 py-1 px-2 rounded border text-center font-medium transition ${
                      vaultMode === 'link'
                        ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
                        : 'bg-plinky-900 text-slate-400 border-plinky-700 hover:text-slate-300'
                    }`}
                  >
                    Link to Existing Vault Entry
                  </button>
                </div>

                {vaultMode === 'link' ? (
                  <div className="space-y-1">
                    <label className="text-slate-300 text-[11px]">Select Vault Credential *</label>
                    <select
                      value={selectedVaultKey}
                      onChange={e => setSelectedVaultKey(e.target.value)}
                      className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 text-xs focus:outline-none focus:border-sky-500 font-mono"
                    >
                      <option value="" disabled>-- Select a vault credential --</option>
                      {vaultEntries.map(e => (
                        <option key={e.id} value={e.id}>
                          {e.id} {e.username ? `(${e.username})` : ''} {e.has_enable_secret ? '[+ Enable Pwd]' : ''}
                        </option>
                      ))}
                    </select>
                    {vaultEntries.length === 0 && (
                      <p className="text-amber-400 text-[11px]">
                        No credentials found in vault (or vault is locked). You can switch to "Create New Vault Entry".
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-slate-300 text-[11px]">Vault Key ID</label>
                        <input
                          type="text"
                          value={vaultKeyId}
                          onChange={e => setVaultKeyId(e.target.value)}
                          placeholder={name.trim() ? `session:${name.trim()}` : 'session:device-name'}
                          className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-slate-300 text-[11px]">Login Password *</label>
                        <input
                          type="password"
                          value={vaultPassword}
                          onChange={e => setVaultPassword(e.target.value)}
                          placeholder="Session login password..."
                          className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                        />
                      </div>
                    </div>

                    {/* Network Device Enable Password Toggle */}
                    <div className="pt-0.5">
                      <label className="flex items-center space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isNetworkDevice}
                          onChange={e => setIsNetworkDevice(e.target.checked)}
                          className="rounded border-plinky-700 text-amber-500 focus:ring-0 bg-plinky-900"
                        />
                        <span className="text-slate-300 text-xs font-medium">
                          Network Device (requires Enable Password / Privileged Exec)
                        </span>
                      </label>
                    </div>

                    {isNetworkDevice && (
                      <div className="p-2 bg-amber-950/20 border border-amber-500/30 rounded space-y-1 animate-in fade-in duration-100">
                        <label className="block text-[11px] text-amber-300 font-medium">
                          Enable Password (Cisco / Arista / Huawei Privileged EXEC)
                        </label>
                        <input
                          type="password"
                          value={vaultEnablePassword}
                          onChange={e => setVaultEnablePassword(e.target.value)}
                          placeholder="e.g. Cisco enable secret..."
                          className="w-full bg-plinky-900 border border-amber-500/40 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-amber-400"
                        />
                      </div>
                    )}
                  </div>
                )}

                <p className="text-[10px] text-slate-400 italic">
                  🔒 Credentials are encrypted with Argon2id and never saved in plaintext PuTTY session files.
                </p>
              </div>
            )}
          </div>

          {/* Paste line delay (T-015) */}
          <div className="p-2.5 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-1 text-[11px]">
            <label className="flex items-center justify-between space-x-2">
              <span className="text-slate-300 font-medium">Paste line delay</span>
              <span className="flex items-center space-x-1.5">
                <input
                  type="number"
                  min={0}
                  max={MAX_PASTE_LINE_DELAY_MS}
                  step={50}
                  value={pasteDelay}
                  onChange={e => setPasteDelay(e.target.value)}
                  placeholder="0"
                  aria-label="Paste line delay in milliseconds"
                  className="w-20 bg-plinky-900 border border-plinky-700 rounded px-2 py-0.5 text-slate-100 text-xs text-right focus:outline-none focus:border-sky-500"
                />
                <span className="text-slate-500">ms</span>
              </span>
            </label>
            <p className="text-slate-500">
              Sends a multi-line paste one line at a time, this far apart, for console ports and network gear that
              drop characters. 0 pastes normally. Up to {MAX_PASTE_LINE_DELAY_MS} ms.
            </p>
          </div>

          {/* Automatic answers from the vault. SSH needs no switch: plink
              logs in by itself. The others answer prompts the device prints,
              so they're opt-in per session. */}
          <div className="p-2.5 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-1.5 text-[11px]">
            <div className="text-slate-300 font-medium">Automatic login from the vault</div>
            {protocol === 'SSH' && (
              <p className="text-slate-500">
                SSH logs in by itself when the vault is unlocked and holds this session's password
                (linked above, or an entry named "session:{name.trim() || 'name'}" or after the host).
              </p>
            )}
            {(protocol === 'Telnet' || protocol === 'Serial') && (
              <label className="flex items-start space-x-2 cursor-pointer">
                <input type="checkbox" checked={autoLogin} onChange={e => setAutoLogin(e.target.checked)} className="mt-0.5" />
                <span className="text-slate-300">
                  Log in automatically
                  <span className="block text-slate-500">Types the vault username and password at the device's Username:/Password: prompts, once per connection.</span>
                </span>
              </label>
            )}
            <label className="flex items-start space-x-2 cursor-pointer">
              <input type="checkbox" checked={autoEnable} onChange={e => setAutoEnable(e.target.checked)} className="mt-0.5" />
              <span className="text-slate-300">
                Send enable password automatically
                <span className="block text-slate-500">
                  After you type enable / en / super and the device asks for a password. Leave off if you hop from this device to others: they would get this device's enable password.
                </span>
              </span>
            </label>
          </div>

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

          {vaultSaveError && (
            <div role="alert" className="p-2 rounded border border-red-500/40 bg-red-950/40 text-red-300 text-[11px]">
              {vaultSaveError}
            </div>
          )}

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
