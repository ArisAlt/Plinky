import React, { useState, useEffect, useRef } from 'react';
import { PuttySession, Protocol } from '../../types/session';
import { 
  Terminal, X, Save, Key, Folder, Tag, Cpu, RefreshCw, 
  Shield, Server, Laptop, ArrowRight, Lock, Trash2
} from 'lucide-react';
import { 
  listSerialPorts, DetectedSerialPort, 
  vaultListEntriesMeta, vaultSetEntry, VaultEntryMeta, VaultEntry,
  vaultIsInitialized, vaultIsUnlocked, vaultGetEntry,
  VAULT_CHANGED_EVENT,
} from '../../services/tauriBridge';
import { VaultUnlockDialog } from '../vault/VaultUnlockDialog';
import { SESSION_SAVED_EVENT, SessionSavedDetail, MAX_PASTE_LINE_DELAY_MS, pasteLineDelayFrom, keepaliveSecondsFrom, keepaliveKeys } from '../../services/appEvents';

type SessionTab = 'general' | 'credentials' | 'jump' | 'serial' | 'advanced';

/** Each protocol's usual port, as PuTTY fills it in. */
const DEFAULT_PORT: Partial<Record<Protocol, number>> = { SSH: 22, Telnet: 23, Rlogin: 513 };

const NO_VAULT_MESSAGE =
  'There is no vault yet, so the password was not saved. Create one first: Vault in the top bar, set a master password, then save this session again.';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (session: PuttySession) => void;
  editingSession?: PuttySession | null;
  savedSessions?: PuttySession[];
  /** A new session's folder, when opened from a folder's "New Session Here". */
  initialFolder?: string;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  onClose,
  onSave,
  editingSession,
  savedSessions = [],
  initialFolder,
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
  // The vault entry this session already uses, when editing. Its password
  // isn't shown: left blank, it stays as it is.
  const [savedVaultKey, setSavedVaultKey] = useState<string | null>(null);
  // Unlock asked for in place; `save` continues the Save that needed it.
  const [unlockFor, setUnlockFor] = useState<null | 'edit' | 'save'>(null);
  const unlockDeclined = useRef(false);
  const [resubmit, setResubmit] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Whether there is a vault to save into. On a first run there is none:
  // saving a password failed with "Vault is locked ... unlock the vault",
  // pointing at something that didn't exist yet.
  const [vaultState, setVaultState] = useState<'unknown' | 'none' | 'locked' | 'ready'>('unknown');
  const checkVault = async () => {
    try {
      if (!(await vaultIsInitialized())) setVaultState('none');
      else setVaultState((await vaultIsUnlocked()) ? 'ready' : 'locked');
    } catch {
      setVaultState('unknown');
    }
  };
  // Automatic answers from the vault (opt-in per session).
  const [autoEnable, setAutoEnable] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);
  // Paste line delay in ms ('' or 0 = paste normally).
  const [pasteDelay, setPasteDelay] = useState('');
  // Connection (T-016): PuTTY's keepalive settings and Plinky's auto-reconnect.
  const [keepalive, setKeepalive] = useState('');
  const [tcpKeepalives, setTcpKeepalives] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(false);

  // Serial-specific state
  const [serialPorts, setSerialPorts] = useState<DetectedSerialPort[]>([]);
  const [isRefreshingPorts, setIsRefreshingPorts] = useState(false);
  const [pickedTab, setTab] = useState<SessionTab>('general');
  const [serialLine, setSerialLine] = useState('');
  const [isCustomSerialLine, setIsCustomSerialLine] = useState(false);
  const [serialSpeed, setSerialSpeed] = useState('9600');
  const [serialDataBits, setSerialDataBits] = useState('8');
  const [serialStopBits, setSerialStopBits] = useState('2'); // 2 = 1 stop bit
  const [serialParity, setSerialParity] = useState('0'); // 0 = None
  const [serialFlowControl, setSerialFlowControl] = useState('1'); // 1 = XON/XOFF

  // Jump Host (MobaXterm style) state
  const [enableJumpHost, setEnableJumpHost] = useState(false);
  const [jumpHost, setJumpHost] = useState('');
  const [jumpPort, setJumpPort] = useState('22');
  const [jumpUsername, setJumpUsername] = useState('');
  // A saved session picked as the bastion: stored by name, so plink uses
  // that session's own host, port, username and key file (tested against a
  // real bastion/target pair with no agent running).
  const [jumpPreset, setJumpPreset] = useState<string | null>(null);
  // The jump host's password, typed here and stored only in the vault (as
  // "jump:<session>", linked by PlinkyJumpVaultKey). Never kept in the
  // PuTTY session. Blank on edit: blank keeps the stored one.
  const [jumpPassword, setJumpPassword] = useState('');
  const [jumpVaultKey, setJumpVaultKey] = useState<string | null>(null);
  const pressedOnBackdrop = useRef(false);
  // The session being edited already goes through a jump host: offer to
  // remove it, and say what saving will do once it's off.
  const hadJumpHost = editingSession?.extra?.PlinkyJumpHost === '1' || editingSession?.extra?.ProxyMethod === '6';

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
    setTab('general');
    setUnlockFor(null);
    unlockDeclined.current = false;
    refreshPorts();
    setVaultSaveError(null);
    vaultListEntriesMeta().then(setVaultEntries).catch(() => {});
    void checkVault();
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
      setJumpPassword('');
      setJumpVaultKey(hasJumpHost && extra.PlinkyJumpVaultKey ? extra.PlinkyJumpVaultKey : null);

      // Load vault credentials key. Shown as the entry itself, password
      // blank = unchanged. It opened on "Link to existing", which with the
      // vault locked was an empty list and a warning, for a session whose
      // login was fine.
      if (extra.PlinkyVaultKey) {
        setUseVault(true);
        setVaultMode('new');
        setSelectedVaultKey(extra.PlinkyVaultKey);
        setVaultKeyId(extra.PlinkyVaultKey);
        setSavedVaultKey(extra.PlinkyVaultKey);
      } else {
        setSavedVaultKey(null);
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
      const ka = keepaliveSecondsFrom(extra);
      setKeepalive(ka ? String(ka) : '');
      setTcpKeepalives(extra.TCPKeepalives === '1');
      setAutoReconnect(extra.PlinkyAutoReconnect === '1');
    } else {
      setName('');
      setHostname('');
      setPort('22');
      setProtocol('SSH');
      setUsername('');
      setFolder(initialFolder || 'Saved Sessions');
      setTags('');
      setPublicKeyFile('');
      setSerialLine('');
      setIsCustomSerialLine(false);
      setSerialSpeed('9600');
      setSerialDataBits('8');
      setSerialStopBits('2');
      setSerialParity('0');
      setSerialFlowControl('1');
      setEnableJumpHost(false);
      setJumpHost('');
      setJumpPort('22');
      setJumpUsername('');
      setJumpPreset(null);
      setUseVault(false);
      setVaultMode('new');
      setSelectedVaultKey('');
      setVaultKeyId('');
      setSavedVaultKey(null);
      setJumpPassword('');
      setJumpVaultKey(null);
      setVaultPassword('');
      setIsNetworkDevice(false);
      setVaultEnablePassword('');
      setAutoEnable(false);
      setAutoLogin(false);
      setPasteDelay('');
      setKeepalive('');
      setTcpKeepalives(false);
      setAutoReconnect(false);
    }
  }, [isOpen, editingSession, initialFolder]);

  // The saved entry says whether it has an enable password; the checkbox
  // used to start unticked on every edit, as if it had none.
  useEffect(() => {
    if (!isOpen || !savedVaultKey) return;
    const meta = vaultEntries.find(v => v.id === savedVaultKey);
    if (meta) setIsNetworkDevice(!!meta.has_enable_secret);
  }, [isOpen, savedVaultKey, vaultEntries]);

  // Ticking "Save credentials", or opening a saved session's credentials,
  // with the vault locked asks for the master password there and then.
  // Once per opening: "Not now" means not now.
  const pickedCredentials = pickedTab === 'credentials';
  useEffect(() => {
    if (isOpen && useVault && vaultState === 'locked' && pickedCredentials && !unlockDeclined.current && unlockFor === null) {
      setUnlockFor('edit');
    }
  }, [isOpen, useVault, vaultState, pickedCredentials, unlockFor]);

  // A Save that stopped for the unlock goes on once the entries are loaded.
  useEffect(() => {
    if (!resubmit) return;
    setResubmit(false);
    formRef.current?.requestSubmit();
  }, [resubmit]);

  const afterUnlock = async () => {
    const again = unlockFor === 'save';
    setUnlockFor(null);
    try { setVaultEntries(await vaultListEntriesMeta()); } catch { /* listed on the next change */ }
    setVaultState('ready');
    if (again) setResubmit(true);
  };

  // Unlocking the vault with this dialog open fills "Link to existing".
  useEffect(() => {
    if (!isOpen) return;
    const reload = () => {
      vaultListEntriesMeta().then(setVaultEntries).catch(() => setVaultEntries([]));
      void checkVault();
    };
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
    // Host first, as in PuTTY; the name defaults to the host when left
    // empty, so a quick save needs one field, not two.
    const sessionName = name.trim() || hostname.trim() || (protocol === 'Serial' ? serialLine.trim() : '');
    if (!sessionName) return;
    setVaultSaveError(null);

    // Writing or checking a vault entry needs it unlocked: ask, then carry on.
    const needsVault = (useVault && vaultMode === 'new') || (!!jumpPassword && enableJumpHost);
    if (needsVault && vaultState !== 'none' && !(await vaultIsUnlocked().catch(() => false))) {
      setUnlockFor('save');
      return;
    }

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
        delete extra.PlinkyJumpVaultKey;
      }
    }

    // The jump host's own vault login. A saved session picked as the jump
    // host brings its own vault entry, so nothing is stored for it here.
    const jumpInUse = protocol === 'SSH' && enableJumpHost && !jumpPreset && !!jumpHost.trim();
    if (jumpInUse && jumpPassword) {
      if (vaultState === 'none') {
        setVaultSaveError(NO_VAULT_MESSAGE);
        setTab('jump');
        return;
      }
      if (!jumpUsername.trim()) {
        setVaultSaveError('Enter the gateway username: the stored password is only sent at that user\'s password prompt.');
        setTab('jump');
        return;
      }
      const key = `jump:${sessionName}`;
      const now = Math.floor(Date.now() / 1000);
      try {
        await vaultSetEntry({
          id: key,
          username: jumpUsername.trim(),
          secret: jumpPassword,
          notes: `Jump host ${jumpUsername.trim()}@${jumpHost.trim()} for session "${sessionName}"`,
          created_at: now,
          updated_at: now,
        });
      } catch (err) {
        const noVault = !(await vaultIsInitialized().catch(() => true));
        setVaultSaveError(noVault
          ? NO_VAULT_MESSAGE
          : `The gateway password wasn't saved: ${String(err)}. Unlock the vault (Vault in the top bar), then save again.`);
        setTab('jump');
        return;
      }
      extra.PlinkyJumpVaultKey = key;
    } else if (!jumpInUse) {
      delete extra.PlinkyJumpVaultKey;
    }

    // Encrypted Vault Credential Binding
    if (useVault) {
      if (vaultMode === 'link' && selectedVaultKey) {
        extra.PlinkyVaultKey = selectedVaultKey;
      } else if (vaultMode === 'new') {
        const finalKeyId = vaultKeyId.trim() || `session:${sessionName}`;
        if (vaultPassword && vaultState === 'none') {
          setVaultSaveError(NO_VAULT_MESSAGE);
          setTab('credentials');
          return;
        }
        const exists = vaultEntries.some(v => v.id === finalKeyId);
        if (vaultPassword || (exists && vaultEnablePassword)) {
          const now = Math.floor(Date.now() / 1000);
          // Left blank, a password stays what it was: replacing the login
          // password used to drop the enable password with it.
          const prev = exists ? await vaultGetEntry(finalKeyId) : null;
          const entry: VaultEntry = {
            id: finalKeyId,
            username: isSerial ? undefined : (username.trim() || prev?.username || undefined),
            // Never trimmed: a password with a leading or trailing space is
            // a different password.
            secret: vaultPassword || prev?.secret || '',
            enable_secret: isNetworkDevice ? (vaultEnablePassword || prev?.enable_secret || undefined) : undefined,
            notes: prev?.notes || `Saved credentials for session "${sessionName}"`,
            created_at: prev?.created_at ?? now,
            updated_at: now,
          };
          if (!entry.secret) {
            setVaultSaveError('Enter the login password to save in the vault.');
            setTab('credentials');
            return;
          }
          // This failed silently when the vault was locked: the dialog
          // closed, the session was linked to an entry that didn't exist,
          // and the password was simply gone. Stay open and say why.
          try {
            await vaultSetEntry(entry);
          } catch (err) {
            const noVault = !(await vaultIsInitialized().catch(() => true));
            setVaultSaveError(noVault
              ? NO_VAULT_MESSAGE
              : `The password wasn't saved: ${String(err)}. Unlock the vault (Vault in the top bar), then save again.`);
            setTab('credentials');
            return;
          }
          extra.PlinkyVaultKey = finalKeyId;
        } else if (exists) {
          extra.PlinkyVaultKey = finalKeyId;
        } else {
          // Linking to an entry that doesn't exist left a dangling key.
          setVaultSaveError('Enter the password to save in the vault, or untick "Save Credentials in Encrypted Vault".');
          setTab('credentials');
          return;
        }
      }
    } else {
      delete extra.PlinkyVaultKey;
    }

    if (autoEnable) extra.PlinkyAutoEnable = '1'; else delete extra.PlinkyAutoEnable;
    if (!isSerial) {
      // Keepalives stop idle NAT/firewall timeouts killing the session and
      // let plink notice a dead link, which is what auto-reconnect acts on.
      Object.assign(extra, keepaliveKeys(parseInt(keepalive, 10) || 0));
      extra.TCPKeepalives = tcpKeepalives ? '1' : '0';
    }
    const autoReconnectOn = autoReconnect && !isSerial;
    if (autoReconnectOn) extra.PlinkyAutoReconnect = '1'; else delete extra.PlinkyAutoReconnect;
    const pasteLineDelayMs = pasteLineDelayFrom({ PlinkyPasteLineDelayMs: pasteDelay });
    if (pasteLineDelayMs > 0) extra.PlinkyPasteLineDelayMs = String(pasteLineDelayMs);
    else delete extra.PlinkyPasteLineDelayMs;
    if (autoLogin && (protocol === 'Telnet' || protocol === 'Serial')) extra.PlinkyAutoLogin = '1';
    else delete extra.PlinkyAutoLogin;

    const session: PuttySession = {
      name: sessionName,
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
      detail: { name: session.name, pasteLineDelayMs, autoReconnect: autoReconnectOn },
    }));
    onClose();
  };

  const isSerial = protocol === 'Serial';
  // The key typed is one the vault already holds (or this session's own):
  // a blank password then keeps the stored one.
  const typedKey = vaultKeyId.trim();
  const keyIsSaved = !!typedKey && (typedKey === savedVaultKey || vaultEntries.some(v => v.id === typedKey));

  // The tabs this protocol has. A dot marks one holding non-default settings.
  const visibleTabs: { id: SessionTab; label: string; on?: boolean }[] = [
    { id: 'general', label: 'General' },
    { id: 'credentials', label: 'Credentials & Vault', on: useVault || (protocol === 'SSH' && !!publicKeyFile.trim()) },
    ...(protocol === 'SSH' ? [{ id: 'jump' as const, label: 'Jump Host', on: enableJumpHost }] : []),
    ...(isSerial ? [{ id: 'serial' as const, label: 'Serial' }] : []),
    { id: 'advanced', label: 'Advanced', on: (!isSerial && (parseInt(keepalive, 10) > 0 || autoReconnect)) || parseInt(pasteDelay, 10) > 0 },
  ];
  // Switching protocol can take away the tab that was open (Jump Host).
  const tab: SessionTab = visibleTabs.some(t => t.id === pickedTab) ? pickedTab : 'general';

  return (
    <div
      // Only a click that starts AND ends on the backdrop closes the dialog.
      // A drag that ends outside (selecting text in a field) used to close it,
      // losing every edit.
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOnBackdrop.current) onClose();
        pressedOnBackdrop.current = false;
      }}
      className="fixed inset-0 bg-plinky-950/75 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none"
    >
      <div role="dialog" aria-modal="true" aria-labelledby="new-session-title" className="bg-plinky-900 border border-plinky-700 rounded-lg w-[560px] max-w-full shadow-2xl flex flex-col overflow-hidden text-xs max-h-[90vh]">
        {/* Header */}
        <div className="p-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <Terminal className="w-4 h-4 text-sky-400" />
            <h3 id="new-session-title" className="font-semibold text-slate-100 text-base">
              {editingSession ? `Edit "${editingSession.name}"` : 'New session'}
            </h3>
          </div>
          <button aria-label="Close"
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-plinky-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs (T-014). Every panel stays mounted, hidden when not
            shown, so switching tabs never loses what was typed. */}
        <div role="tablist" aria-label="Session settings" className="flex items-end px-2 pt-1.5 bg-plinky-950 border-b border-plinky-800 shrink-0 overflow-x-auto overflow-y-hidden">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-3 py-1.5 -mb-px rounded-t border text-meta font-medium whitespace-nowrap transition ${
                tab === t.id
                  ? 'bg-plinky-900 border-plinky-800 border-b-plinky-900 text-sky-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
              {t.on && <span aria-hidden className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-sky-400" />}
            </button>
          ))}
        </div>

        {/* Form Body */}
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          // A required field on a hidden tab would block Save with nothing
          // on screen to say why: show the tab that holds it.
          onInvalidCapture={e => {
            const owner = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab as SessionTab | undefined;
            if (owner && owner !== tab) setTab(owner);
          }}
          className="flex-1 flex flex-col overflow-hidden"
        >
          {/* A fixed height, not a floor. Measured body heights per tab
              (13px text, every option ticked): General 350, Credentials 330
              to 531, Jump Host 330 to 407, Advanced 330. With only a floor
              the dialog grew and re-centred as tabs changed, so the tabs and
              Save moved under the pointer; once, a click aimed at Save landed
              on the backdrop and closed it unsaved. 440 px
              holds every tab but a fully expanded Credentials, which scrolls
              inside; short screens get less, never more than fits. */}
          <div className="p-4 overflow-y-auto h-[min(440px,calc(100vh-220px))] shrink-0">
            <div data-tab="general" hidden={tab !== 'general'} className="space-y-3">
              {/* Protocol Selection */}
              <div className="space-y-1">
                <label htmlFor="new-session-modal-connection-protocol" className="text-slate-300 font-medium">Connection Protocol</label>
                <select id="new-session-modal-connection-protocol"
                  value={protocol}
                  onChange={e => {
                    const nextProto = e.target.value as Protocol;
                    // The port follows the protocol while it is still the old
                    // one's default: a Telnet copy switched to SSH kept 23.
                    const was = DEFAULT_PORT[protocol];
                    const next = DEFAULT_PORT[nextProto];
                    if (next && (!port.trim() || (was && port.trim() === String(was)))) setPort(String(next));
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
                    <Cpu className="w-3.5 h-3.5 text-slate-400" />
                    <span>Serial Port & Hardware Line Settings</span>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-slate-300 text-meta">Serial Line (COM / USB Port) *</label>
                        <button
                          type="button"
                          onClick={refreshPorts}
                          title="Scan for plugged-in USB and serial devices"
                          className="text-slate-400 hover:text-sky-400 flex items-center space-x-1 text-meta transition"
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
                            aria-label="Serial line"
                            placeholder="/dev/ttyUSB0 or COM3"
                            value={serialLine}
                            onChange={e => setSerialLine(e.target.value)}
                            className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                          />
                          <button
                            type="button"
                            onClick={() => setIsCustomSerialLine(false)}
                            className="px-2 py-1 rounded bg-plinky-800 text-slate-300 hover:bg-plinky-700 text-meta"
                          >
                            List
                          </button>
                        </div>
                      ) : (
                        <select
                          aria-label="Serial line"
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
                      <label htmlFor="new-session-modal-speed-baud" className="text-slate-300 text-meta">Speed (Baud)</label>
                      <select id="new-session-modal-speed-baud"
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

                </div>
              ) : (
                /* NETWORK PROTOCOL FIELDS (SSH / Telnet / RAW / Rlogin) */
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2 space-y-1">
                      <label htmlFor="new-session-modal-host-name-or-ip-address" className="text-slate-300 font-medium">Host Name or IP Address *</label>
                      <input id="new-session-modal-host-name-or-ip-address"
                        type="text"
                        required
                        placeholder="192.0.2.10 or router.internal"
                        value={hostname}
                        onChange={e => setHostname(e.target.value)}
                        className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-plinky-muted font-mono focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="new-session-modal-port" className="text-slate-300 font-medium">Port</label>
                      <input id="new-session-modal-port"
                        type="number"
                        value={port}
                        onChange={e => setPort(e.target.value)}
                        className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  </div>
                  {(protocol === 'Telnet' || protocol === 'RAW') && port.trim() === '22' && (
                    <div role="status" className="flex items-center justify-between gap-2 p-2 rounded border border-amber-500/40 bg-amber-950/30 text-amber-300 text-meta">
                      <span>Port 22 is SSH's port. A {protocol === 'RAW' ? 'Raw' : 'Telnet'} session there gets the SSH greeting and is closed.</span>
                      <button
                        type="button"
                        onClick={() => setProtocol('SSH')}
                        className="shrink-0 px-2 py-0.5 rounded border border-amber-500/50 text-amber-200 hover:bg-amber-500/10"
                      >
                        Use SSH
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* Session name: after the host, as in PuTTY */}
              <div className="space-y-1">
                <label htmlFor="new-session-modal-session-name" className="text-slate-300 font-medium">Session name</label>
                <input id="new-session-modal-session-name"
                  type="text"
                  placeholder={(isSerial ? serialLine.trim() : hostname.trim()) || (isSerial ? 'e.g. core-sw1 console' : 'Defaults to the host name')}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-plinky-muted focus:outline-none focus:border-sky-500"
                />
                {editingSession && name.trim() !== editingSession.name && (
                  <p className="text-amber-400 text-meta">
                    Changing the name saves a new session. "{editingSession.name}" stays as it is.
                  </p>
                )}
              </div>

              {/* Organization & Tags */}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label htmlFor="new-session-modal-folder-category" className="text-slate-300 font-medium flex items-center space-x-1">
                    <Folder className="w-3.5 h-3.5 text-sky-400" />
                    <span>Folder Category</span>
                  </label>
                  <input id="new-session-modal-folder-category"
                    type="text"
                    placeholder="e.g. Staging or Network"
                    value={folder}
                    onChange={e => setFolder(e.target.value)}
                    className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-plinky-muted focus:outline-none focus:border-sky-500"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="new-session-modal-tags-comma-separated" className="text-slate-300 font-medium flex items-center space-x-1">
                    <Tag className="w-3.5 h-3.5 text-slate-400" />
                    <span>Tags (comma-separated)</span>
                  </label>
                  <input id="new-session-modal-tags-comma-separated"
                    type="text"
                    placeholder="cisco, core, serial, lab"
                    value={tags}
                    onChange={e => setTags(e.target.value)}
                    className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-plinky-muted focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

            </div>

            <div data-tab="credentials" hidden={tab !== 'credentials'} className="space-y-3">
                  {!isSerial && (
                    <div className="space-y-1">
                      <label htmlFor="new-session-modal-default-username" className="text-slate-300 font-medium">Username</label>
                      <input id="new-session-modal-default-username"
                        type="text"
                        autoComplete="off"
                        placeholder="e.g. root, admin, or deploy"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-plinky-muted focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  )}
                  {protocol === 'SSH' && (
                    <div className="space-y-1">
                      <label htmlFor="new-session-modal-private-key-file-ppk" className="text-slate-300 font-medium flex items-center space-x-1">
                        <Key className="w-3.5 h-3.5 text-slate-400" />
                        <span>Private Key File (.ppk)</span>
                      </label>
                      <input id="new-session-modal-private-key-file-ppk"
                        type="text"
                        placeholder="/path/to/key.ppk (or Pageant/agent will handle auth)"
                        value={publicKeyFile}
                        onChange={e => setPublicKeyFile(e.target.value)}
                        className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-plinky-muted font-mono focus:outline-none focus:border-sky-500"
                      />
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
                      <Lock className="w-3.5 h-3.5 text-slate-400" />
                      <span>Save Credentials in Encrypted Vault</span>
                    </span>
                  </label>
                  {useVault && (
                    <span className="text-meta text-slate-400 font-mono">
                      Argon2id + AES-256-GCM
                    </span>
                  )}
                </div>
                {useVault && vaultState === 'none' && (
                  <p role="status" className="p-2 rounded border border-amber-500/40 bg-amber-950/30 text-amber-300 text-meta">
                    No vault yet. Create one first: Vault in the top bar, then set a master password. Until then a password here can't be saved.
                  </p>
                )}
                {useVault && vaultState === 'locked' && (
                  <div role="status" className="flex items-center justify-between gap-2 p-2 rounded border border-amber-500/40 bg-amber-950/30 text-amber-300 text-meta">
                    <span>The vault is locked, so this session's password can't be read or saved.</span>
                    <button
                      type="button"
                      onClick={() => setUnlockFor('edit')}
                      className="shrink-0 px-2 py-0.5 rounded border border-amber-500/50 text-amber-200 hover:bg-amber-500/10"
                    >
                      Unlock…
                    </button>
                  </div>
                )}

                {useVault && (
                  <div className="space-y-2.5 pt-1 border-t border-plinky-800/80 animate-in fade-in duration-150">

                    {vaultMode === 'link' ? (
                      <div className="space-y-1">
                        <label htmlFor="new-session-modal-select-vault-credential" className="text-slate-300 text-meta">Select Vault Credential *</label>
                        <select id="new-session-modal-select-vault-credential"
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
                          <p className="text-amber-400 text-meta">
                            No credentials found in vault (or vault is locked). You can switch to "Create New Vault Entry".
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <label htmlFor="new-session-modal-vault-key-id" className="text-slate-300 text-meta">Vault Key ID</label>
                            <input id="new-session-modal-vault-key-id"
                              type="text"
                              value={vaultKeyId}
                              onChange={e => setVaultKeyId(e.target.value)}
                              placeholder={name.trim() ? `session:${name.trim()}` : 'session:device-name'}
                              className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="new-session-modal-login-password" className="text-slate-300 text-meta">
                              {keyIsSaved ? 'Login Password' : 'Login Password *'}
                            </label>
                            <input id="new-session-modal-login-password"
                              type="password"
                              // WebView2 filled a remembered password in here
                              // on edit, and Save wrote it over the vault's.
                              autoComplete="new-password"
                              value={vaultPassword}
                              onChange={e => setVaultPassword(e.target.value)}
                              placeholder={keyIsSaved ? 'Saved. Type to replace' : 'Session login password...'}
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
                              className="rounded border-plinky-700 text-sky-500 focus:ring-0 bg-plinky-900"
                            />
                            <span className="text-slate-300 text-xs font-medium">
                              Network Device (requires Enable Password / Privileged Exec)
                            </span>
                          </label>
                        </div>

                        {isNetworkDevice && (
                          <div className="p-2 bg-plinky-950/60 border border-plinky-700 rounded space-y-1 animate-in fade-in duration-100">
                            <label htmlFor="new-session-modal-enable-password-cisco-arista-h" className="block text-meta text-slate-300 font-medium">
                              Enable Password (Cisco / Arista / Huawei Privileged EXEC)
                            </label>
                            <input id="new-session-modal-enable-password-cisco-arista-h"
                              type="password"
                              autoComplete="new-password"
                              value={vaultEnablePassword}
                              onChange={e => setVaultEnablePassword(e.target.value)}
                              placeholder="e.g. Cisco enable secret..."
                              className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Mode toggle, under the fields it switches */}
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

                    <p className="flex items-center gap-1.5 text-meta text-slate-400">
                      <Lock className="w-3 h-3 shrink-0 text-plinky-muted" aria-hidden="true" />
                      <span>Stored encrypted in the vault, never in PuTTY's session files.</span>
                    </p>
                  </div>
                )}
              </div>

              {/* Automatic answers from the vault. SSH needs no switch: plink
                  logs in by itself. The others answer prompts the device prints,
                  so they're opt-in per session. */}
              <div className="p-2.5 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-1.5 text-meta">
                <div className="text-slate-300 font-medium">Automatic login from the vault</div>
                {protocol === 'SSH' && (
                  <p className="text-plinky-muted">
                    SSH logs in by itself when the vault is unlocked and holds this session's password
                    (linked above, or an entry named "session:{name.trim() || 'name'}" or after the host).
                  </p>
                )}
                {(protocol === 'Telnet' || protocol === 'Serial') && (
                  <label className="flex items-start space-x-2 cursor-pointer">
                    <input type="checkbox" checked={autoLogin} onChange={e => setAutoLogin(e.target.checked)} className="mt-0.5" />
                    <span className="text-slate-300">
                      Log in automatically
                      <span className="block text-plinky-muted">Types the vault username and password at the device's Username:/Password: prompts, once per connection.</span>
                    </span>
                  </label>
                )}
                <label className="flex items-start space-x-2 cursor-pointer">
                  <input type="checkbox" checked={autoEnable} onChange={e => setAutoEnable(e.target.checked)} className="mt-0.5" />
                  <span className="text-slate-300">
                    Send enable password automatically
                    <span className="block text-plinky-muted">
                      After you type enable / en / super and the device asks for a password. Leave off if you hop from this device to others: they would get this device's enable password.
                    </span>
                  </span>
                </label>
              </div>

            </div>

            <div data-tab="jump" hidden={tab !== 'jump'} className="space-y-3">
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
                    {hadJumpHost && enableJumpHost && (
                      <button
                        type="button"
                        onClick={() => {
                          setEnableJumpHost(false);
                          setJumpPreset(null);
                          setJumpHost('');
                          setJumpPort('22');
                          setJumpUsername('');
                          setJumpPassword('');
                        }}
                        className="flex items-center space-x-1 px-2 py-0.5 rounded border border-rose-500/40 text-rose-300 hover:bg-rose-500/10 text-meta shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Remove Jump Host</span>
                      </button>
                    )}
                  </div>
                  {hadJumpHost && !enableJumpHost && (
                    <p role="status" className="text-amber-300/90 text-meta">
                      The jump host will be removed when you save. This session will then connect directly.
                    </p>
                  )}

                  {enableJumpHost && (
                    <div className="space-y-2.5 pt-1 border-t border-plinky-800/80 animate-in fade-in duration-150">
                      {/* Visual Topology Route Banner (MobaXterm Style) */}
                      <div className="p-2 rounded bg-plinky-900/90 border border-sky-500/30 flex items-center justify-between text-meta">
                        <div className="flex items-center space-x-1">
                          <Laptop className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                          <span className="text-slate-400">Client</span>
                        </div>
                        <div className="flex items-center space-x-1 text-plinky-muted">
                          <div className="h-px w-4 bg-sky-500/50" />
                          <span className="text-meta text-sky-400 uppercase font-semibold">SSH</span>
                          <ArrowRight className="w-3 h-3 text-sky-400" />
                        </div>
                        <div className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-sky-950/80 border border-sky-500/50">
                          <Shield className="w-3 h-3 text-slate-400 shrink-0" />
                          <span className="text-slate-200 font-mono font-medium truncate max-w-[160px]" title={jumpHost || 'Jump Host'}>
                            {jumpHost.trim() ? (jumpUsername ? `${jumpUsername}@${jumpHost}` : jumpHost) : 'Bastion'}
                          </span>
                        </div>
                        <div className="flex items-center space-x-1 text-plinky-muted">
                          <div className="h-px w-4 bg-sky-500/50" />
                          <span className="text-meta text-sky-400 uppercase font-semibold">SSH</span>
                          <ArrowRight className="w-3 h-3 text-slate-400" />
                        </div>
                        <div className="flex items-center space-x-1">
                          <Server className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="text-sky-200 font-mono font-medium truncate max-w-[150px]" title={hostname || 'Target'}>
                            {hostname.trim() || 'Target'}
                          </span>
                        </div>
                      </div>

                      {/* Preset from existing saved sessions */}
                      {savedSessions.length > 0 && (
                        <div className="space-y-1">
                          <label htmlFor="new-session-modal-populate-from-saved-session" className="text-slate-400 text-meta">Populate from Saved Session</label>
                          <select id="new-session-modal-populate-from-saved-session"
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
                          <label htmlFor="new-session-modal-jump-host-gateway-ip" className="text-slate-300 text-meta">Jump Host / Gateway IP *</label>
                          <input id="new-session-modal-jump-host-gateway-ip"
                            type="text"
                            required={enableJumpHost}
                            placeholder="bastion.internal or jump.corp.com"
                            value={jumpHost}
                            onChange={e => { setJumpPreset(null); setJumpHost(e.target.value); }}
                            className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="new-session-modal-port-2" className="text-slate-300 text-meta">Port</label>
                          <input id="new-session-modal-port-2"
                            type="number"
                            value={jumpPort}
                            onChange={e => { setJumpPreset(null); setJumpPort(e.target.value); }}
                            className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label htmlFor="new-session-modal-gateway-username" className="text-slate-300 text-meta">Gateway Username</label>
                        <input id="new-session-modal-gateway-username"
                          type="text"
                          placeholder="bastion_user"
                          value={jumpUsername}
                          onChange={e => { setJumpPreset(null); setJumpUsername(e.target.value); }}
                          className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
                        />
                      </div>

                      {jumpPreset ? (
                        <p className="text-plinky-muted text-meta">
                          Logs in to the gateway with the vault password saved for "{jumpPreset}", if it has one.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          <label className="text-slate-300 text-meta">Gateway Password (saved in the vault)</label>
                          <input
                            type="password"
                            autoComplete="new-password"
                            aria-label="Gateway Password"
                            placeholder={jumpVaultKey ? '(stored in the vault; blank keeps it)' : 'optional: leave blank to type it at connect'}
                            value={jumpPassword}
                            onChange={e => setJumpPassword(e.target.value)}
                            className="w-full bg-plinky-900 border border-plinky-700 rounded px-2 py-1 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
                          />
                          <p className="text-plinky-muted text-meta">
                            Sent only at {jumpUsername.trim() || '<user>'}@{jumpHost.trim() || '<gateway>'}'s password prompt, once.
                            The target then logs in with this session's own vault password (Credentials &amp; Vault).
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

            </div>

            <div data-tab="serial" hidden={tab !== 'serial'} className="space-y-3">
              <div className="p-3 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-2">
                <div className="flex items-center space-x-2 text-slate-300 font-medium pb-1 border-b border-plinky-800">
                  <Cpu className="w-3.5 h-3.5 text-slate-400" />
                  <span>Line settings</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <div className="space-y-1">
                    <label htmlFor="new-session-modal-data-bits" className="text-slate-400 text-meta">Data Bits</label>
                    <select id="new-session-modal-data-bits"
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
                    <label htmlFor="new-session-modal-stop-bits" className="text-slate-400 text-meta">Stop Bits</label>
                    <select id="new-session-modal-stop-bits"
                      value={serialStopBits}
                      onChange={e => setSerialStopBits(e.target.value)}
                      className="w-full bg-plinky-900 border border-plinky-700 rounded px-1.5 py-0.5 text-slate-200 text-xs"
                    >
                      <option value="2">1</option>
                      <option value="4">2</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="new-session-modal-parity" className="text-slate-400 text-meta">Parity</label>
                    <select id="new-session-modal-parity"
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
                    <label htmlFor="new-session-modal-flow-control" className="text-slate-400 text-meta">Flow Control</label>
                    <select id="new-session-modal-flow-control"
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
                  </div>
            </div>

            <div data-tab="advanced" hidden={tab !== 'advanced'} className="space-y-3">
              {/* Connection (T-016): keepalives + auto-reconnect */}
              {!isSerial && (
                <div className="p-2.5 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-1.5 text-meta">
                  <div className="text-slate-300 font-medium">Connection</div>
                  <label className="flex items-center justify-between space-x-2">
                    <span className="text-slate-300">Send keepalives every</span>
                    <span className="flex items-center space-x-1.5">
                      <input
                        type="number"
                        min={0}
                        step={5}
                        value={keepalive}
                        onChange={e => setKeepalive(e.target.value)}
                        placeholder="0"
                        aria-label="Keepalive interval in seconds"
                        className="w-20 bg-plinky-900 border border-plinky-700 rounded px-2 py-0.5 text-slate-100 text-xs text-right focus:outline-none focus:border-sky-500"
                      />
                      <span className="text-plinky-muted">s (0 = off)</span>
                    </span>
                  </label>
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input type="checkbox" checked={tcpKeepalives} onChange={e => setTcpKeepalives(e.target.checked)} />
                    <span className="text-slate-300">TCP keepalives</span>
                  </label>
                  <label className="flex items-start space-x-2 cursor-pointer">
                    <input type="checkbox" checked={autoReconnect} onChange={e => setAutoReconnect(e.target.checked)} className="mt-0.5" />
                    <span className="text-slate-300">
                      Reconnect automatically if the connection drops
                      <span className="block text-plinky-muted">Not after you type exit or a login fails. Tries 5 times, waiting longer each time.</span>
                    </span>
                  </label>
                </div>
              )}

              {/* Paste line delay (T-015) */}
              <div className="p-2.5 bg-plinky-950/70 border border-plinky-800 rounded-md space-y-1 text-meta">
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
                    <span className="text-plinky-muted">ms</span>
                  </span>
                </label>
                <p className="text-plinky-muted">
                  Sends a multi-line paste one line at a time, this far apart, for console ports and network gear that
                  drop characters. 0 pastes normally. Up to {MAX_PASTE_LINE_DELAY_MS} ms.
                </p>
              </div>

            </div>

            {vaultSaveError && (
              <div role="alert" className="p-2 rounded border border-rose-500/40 bg-rose-950/40 text-rose-300 text-meta">
                {vaultSaveError}
              </div>
            )}

          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-2 px-4 py-3 border-t border-plinky-800 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded bg-plinky-800 text-slate-300 hover:bg-plinky-700 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-sky-700 hover:brightness-110 text-on-accent font-medium shadow-sm transition"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{editingSession ? 'Save Changes' : 'Save session'}</span>
            </button>
          </div>
        {unlockFor && (
            <VaultUnlockDialog
              reason={unlockFor === 'save'
                ? 'Saving this session writes its password to the vault. Unlock it and the save carries on.'
                : 'This session keeps its password in the vault. Unlock it to see or change the entry.'}
              onUnlocked={() => { void afterUnlock(); }}
              onCancel={() => { unlockDeclined.current = true; setUnlockFor(null); }}
            />
          )}
        </form>
      </div>
    </div>
  );
};
