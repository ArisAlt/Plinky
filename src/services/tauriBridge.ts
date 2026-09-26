import { PuttySession, HostKeyEntry, PpkInfo, SftpFileEntry, TunnelEntry, Protocol } from '../types/session';

// Check if running inside Tauri runtime
export const isTauriEnvironment = (): boolean => {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window || !!(window as any).isTauri);
};

export interface PuttyDetectInfo {
  path: string | null;
  version: string | null;
  ok: boolean;
  reason: string | null;
}

export interface AttachInfo {
  session_id: string;
  replay_data: number[];
  truncated: boolean;
  is_live: boolean;
  pending_prompt?: HostKeyPromptInfo | null;
}

export interface HostKeyPromptInfo {
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  raw_prompt: string;
}

export interface PromptEvent {
  session_id: string;
  prompt: HostKeyPromptInfo;
}

// Fallback demo sessions for browser development/preview mode
const DEMO_SESSIONS: PuttySession[] = [
  {
    name: "Production Cluster Alpha",
    hostname: "192.0.2.10",
    port: 22,
    protocol: "SSH",
    username: "deploy",
    folder: "Production",
    tags: ["prod", "us-east", "primary"],
    lastConnected: Date.now() - 3600000,
  },
  {
    name: "Production Cluster Beta",
    hostname: "192.0.2.11",
    port: 22,
    protocol: "SSH",
    username: "deploy",
    folder: "Production",
    tags: ["prod", "us-east", "replica"],
    lastConnected: Date.now() - 7200000,
  },
  {
    name: "Staging Gateway",
    hostname: "192.0.2.20",
    port: 2222,
    protocol: "SSH",
    username: "admin",
    folder: "Staging",
    tags: ["staging", "bastion"],
    lastConnected: Date.now() - 86400000,
  },
  {
    name: "Edge Gateway Router",
    hostname: "192.0.2.1",
    port: 22,
    protocol: "SSH",
    username: "netops",
    folder: "Networking",
    tags: ["cisco", "core-router"],
    lastConnected: Date.now() - 172800000,
  },
  {
    name: "Switch Console USB0",
    hostname: "/dev/ttyUSB0",
    port: 9600,
    protocol: "Serial",
    folder: "Hardware",
    tags: ["serial", "console"],
    lastConnected: Date.now() - 259200000,
  },
  {
    name: "Default Settings",
    hostname: "",
    port: 22,
    protocol: "SSH",
    folder: "General",
    tags: ["default"],
  },
];

const DEMO_HOSTKEYS: HostKeyEntry[] = [
  {
    keyType: "ssh-ed25519",
    port: 22,
    hostname: "192.0.2.10",
    fingerprint: "SHA256:4t7E0k5M2ZgJ9V8W7K6L5X4Y3Z2A1B0C9D8E7F6G5H4",
    rawKey: "0x1234abcd5678ef90...",
  },
  {
    keyType: "ecdsa-sha2-nistp256",
    port: 22,
    hostname: "192.0.2.20",
    fingerprint: "SHA256:9A8B7C6D5E4F3G2H1I0J9K8L7M6N5O4P3Q2R1S0T",
    rawKey: "0xabcdef1234567890...",
  },
];

export async function detectPutty(): Promise<PuttyDetectInfo> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<PuttyDetectInfo>('putty_detect');
    } catch (e) {
      console.warn("Failed to invoke putty_detect via Tauri:", e);
    }
  }
  return {
    path: "/usr/bin/plink",
    version: "0.85",
    ok: true,
    reason: null,
  };
}

import { getSessionMetadata, saveSessionFolder, saveSessionTags } from './sessionMetadata';

// PuTTY stores protocols lowercase ("ssh", "serial", ...). Uppercasing them
// produced "SERIAL"/"TELNET", which matched neither the Protocol type nor
// the edit modal's options -- a serial session showed a generic badge and
// opened in the editor displaying "SSH".
function canonicalProtocol(raw: unknown): Protocol {
  switch (String(raw || 'ssh').toLowerCase()) {
    case 'serial': return 'Serial';
    case 'telnet': return 'Telnet';
    case 'rlogin': return 'Rlogin';
    case 'raw': return 'RAW';
    default: return 'SSH';
  }
}

function normalizeSession(raw: any): PuttySession {
  const meta = getSessionMetadata(raw.name);
  const folder = raw.folder 
    || raw.extra?.PlinkyFolder 
    || meta?.folder 
    || 'Saved Sessions';

  let tags = raw.tags;
  if (!tags || tags.length === 0) {
    if (raw.extra?.PlinkyTags) {
      tags = raw.extra.PlinkyTags.split(',').map((t: string) => t.trim()).filter(Boolean);
    } else if (meta?.tags && meta.tags.length > 0) {
      tags = meta.tags;
    } else {
      tags = [];
    }
  }

  return {
    ...raw,
    hostname: raw.hostname || raw.host_name || '',
    host_name: raw.host_name || raw.hostname || '',
    port: raw.port || raw.port_number || 22,
    port_number: raw.port_number || raw.port || 22,
    username: raw.username || raw.user_name || '',
    user_name: raw.user_name || raw.username || '',
    publicKeyFile: raw.publicKeyFile || raw.public_key_file || '',
    public_key_file: raw.public_key_file || raw.publicKeyFile || '',
    protocol: canonicalProtocol(raw.protocol),
    extra: raw.extra || {},
    tags,
    folder,
    lastConnected: raw.lastConnected,
  };
}

export function parsePortForwardings(raw: string | undefined, sessionName: string): TunnelEntry[] {
  if (!raw || !raw.trim()) return [];
  const entries: TunnelEntry[] = [];
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const typeChar = item[0]?.toUpperCase();
    const rest = item.slice(1);
    
    if (typeChar === 'D') {
      const port = parseInt(rest.replace('=', ''), 10);
      if (port) {
        entries.push({
          id: `tunnel-${sessionName}-${i}`,
          type: 'Dynamic',
          srcPort: port,
          active: true,
          sessionName,
          bytesTransferred: 0,
        });
      }
    } else if (typeChar === 'L' || typeChar === 'R') {
      const type = typeChar === 'L' ? 'Local' : 'Remote';
      const [srcPart, destPart] = rest.split('=');
      const srcPort = parseInt(srcPart, 10);
      if (srcPort && destPart) {
        const [destHost, destPortStr] = destPart.split(':');
        const destPort = parseInt(destPortStr, 10);
        entries.push({
          id: `tunnel-${sessionName}-${i}`,
          type,
          srcPort,
          destHost: destHost || 'localhost',
          destPort: destPort || 80,
          active: true,
          sessionName,
          bytesTransferred: 0,
        });
      }
    }
  }
  return entries;
}

export function serializePortForwardings(entries: TunnelEntry[]): string {
  const parts: string[] = [];
  for (const t of entries) {
    if (!t.active) continue;
    if (t.type === 'Dynamic') {
      parts.push(`D${t.srcPort}`);
    } else if (t.type === 'Local') {
      parts.push(`L${t.srcPort}=${t.destHost || 'localhost'}:${t.destPort || 80}`);
    } else if (t.type === 'Remote') {
      parts.push(`R${t.srcPort}=${t.destHost || '127.0.0.1'}:${t.destPort || 80}`);
    }
  }
  return parts.join(',');
}

export async function listPuttySessions(): Promise<PuttySession[]> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const rawList = await invoke<any[]>('list_putty_sessions');
      return rawList.map(normalizeSession);
    } catch (e) {
      console.warn("Failed to invoke Tauri list_putty_sessions, using fallback:", e);
      return DEMO_SESSIONS.map(normalizeSession);
    }
  }
  // Browser preview mode
  return DEMO_SESSIONS.map(normalizeSession);
}

export async function readPuttySession(name: string): Promise<PuttySession | null> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<any>('read_putty_session', { name });
      return raw ? normalizeSession(raw) : null;
    } catch (e) {
      console.warn(`Failed to read session ${name} via Tauri:`, e);
      const found = DEMO_SESSIONS.find(s => s.name === name);
      return found ? normalizeSession(found) : null;
    }
  }
  const found = DEMO_SESSIONS.find(s => s.name === name);
  return found ? normalizeSession(found) : null;
}

export async function writePuttySession(session: PuttySession): Promise<boolean> {
  const extra = { ...(session.extra || {}) };
  if (session.folder) {
    extra.PlinkyFolder = session.folder;
    saveSessionFolder(session.name, session.folder);
  }
  if (session.tags && session.tags.length > 0) {
    extra.PlinkyTags = session.tags.join(',');
    saveSessionTags(session.name, session.tags);
  } else {
    // extra is copied from the session being edited, so a stale PlinkyTags
    // survived clearing every tag and the tags came straight back.
    delete extra.PlinkyTags;
    saveSessionTags(session.name, []);
  }

  const payload = {
    name: session.name,
    host_name: session.hostname || session.host_name || '',
    port_number: session.port || session.port_number || 22,
    user_name: session.username || session.user_name || '',
    protocol: (session.protocol || 'ssh').toLowerCase(),
    public_key_file: session.publicKeyFile || session.public_key_file || '',
    // First-class field on the Rust side, not part of extra. Omitting it
    // deserialized as "" and rewrote the session file with an empty
    // LogFileName=, wiping a real PuTTY session's logging setting on any edit.
    log_file_name: session.log_file_name || '',
    extra,
  };
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_putty_session', { session: payload });
      return true;
    } catch (e) {
      console.error("Failed to write session via Tauri:", e);
      return false;
    }
  }
  const idx = DEMO_SESSIONS.findIndex(s => s.name === session.name);
  if (idx >= 0) {
    DEMO_SESSIONS[idx] = normalizeSession({ ...session, ...payload, folder: session.folder, tags: session.tags });
  } else {
    DEMO_SESSIONS.push(normalizeSession({ ...session, ...payload, folder: session.folder, tags: session.tags }));
  }
  return true;
}

/**
 * Moves sessions between folders in one all-or-nothing save: a folder
 * rename or move rewrites every session under it. Throws with the backend's
 * message when nothing (or, if a rollback also failed, not everything) was
 * saved. The sidecar mirror is only updated once PuTTY's store has changed.
 */
export async function setSessionFolders(changes: [string, string][]): Promise<void> {
  if (changes.length === 0) return;
  if (isTauriEnvironment()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_session_folders', { changes });
  } else {
    const missing = changes.find(([name]) => !DEMO_SESSIONS.some(s => s.name === name));
    if (missing) throw new Error(`Session not found: ${missing[0]}`);
    for (const [name, folder] of changes) {
      const idx = DEMO_SESSIONS.findIndex(s => s.name === name);
      const s = DEMO_SESSIONS[idx];
      DEMO_SESSIONS[idx] = { ...s, folder, extra: { ...(s.extra || {}), PlinkyFolder: folder } };
    }
  }
  for (const [name, folder] of changes) saveSessionFolder(name, folder);
}

export async function listPuttyHostKeys(): Promise<HostKeyEntry[]> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<HostKeyEntry[]>('list_putty_hostkeys');
    } catch (e) {
      console.warn("Failed to invoke list_putty_hostkeys, using fallback:", e);
      return DEMO_HOSTKEYS;
    }
  }
  return DEMO_HOSTKEYS;
}

export async function inspectPpk(path: string): Promise<PpkInfo | null> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<PpkInfo>('inspect_ppk', { path });
    } catch (e) {
      console.warn("Failed to inspect ppk via Tauri:", e);
      return null;
    }
  }
  return {
    path,
    version: 3,
    algorithm: "ssh-ed25519",
    isEncrypted: false,
    comment: "imported-key-preview",
    fingerprintSha256: "SHA256:7u8I9O0P1Q2W3E4R5T6Y7U8I9O0P1Q2W3E4R5T6Y",
  };
}

/**
 * Which server an SFTP call goes to. `password` is only for one typed into
 * the SFTP pane: a saved session's vault password is read in the backend
 * and never passes through here.
 */
export interface SftpTarget {
  sessionName: string;
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
}

/** Prefixes the backend puts on errors the SFTP pane acts on. */
export const SFTP_ERR_PASSWORD = '[password] ';
export const SFTP_ERR_HOSTKEY = '[hostkey] ';

async function sftpInvoke<T>(cmd: string, t: SftpTarget, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, {
    sessionName: t.sessionName,
    hostname: t.hostname || undefined,
    port: t.port || undefined,
    username: t.username || undefined,
    password: t.password || undefined,
    ...args,
  });
}

// Browser dev preview only (no backend): a small fixed tree so the pane can
// be laid out. The desktop app never falls back to it -- failures throw.
const DEMO_REMOTE: SftpFileEntry[] = [
  { name: "etc", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "root", group: "root", modified: "Sep 22 18:05" },
  { name: "app.log", isDir: false, isSymlink: false, size: 2048590, permissions: "-rw-r--r--", owner: "deploy", group: "deploy", modified: "Sep 22 20:15" },
];
const DEMO_LOCAL: SftpFileEntry[] = [
  { name: "Documents", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "", group: "", modified: "Sep 22 20:10" },
  { name: "notes.txt", isDir: false, isSymlink: false, size: 1250, permissions: "-rw-r--r--", owner: "", group: "", modified: "Sep 22 19:40" },
];

/** The remote folder psftp starts in: the user's home. */
export async function sftpRemoteHome(t: SftpTarget): Promise<string> {
  if (!isTauriEnvironment()) return '/home/demo';
  return sftpInvoke<string>('sftp_home_dir', t);
}

export async function sftpList(t: SftpTarget, path: string): Promise<SftpFileEntry[]> {
  if (!isTauriEnvironment()) return DEMO_REMOTE;
  return sftpInvoke<SftpFileEntry[]>('sftp_list', t, { remotePath: path });
}

export async function sftpMkdir(t: SftpTarget, path: string): Promise<void> {
  if (!isTauriEnvironment()) return;
  await sftpInvoke('sftp_mkdir', t, { remotePath: path });
}

export async function sftpRemove(t: SftpTarget, path: string, isDir: boolean): Promise<void> {
  if (!isTauriEnvironment()) return;
  await sftpInvoke(isDir ? 'sftp_rmdir' : 'sftp_rm', t, { remotePath: path });
}

export async function sftpUpload(t: SftpTarget, localPath: string, remotePath: string): Promise<void> {
  if (!isTauriEnvironment()) return;
  await sftpInvoke('sftp_upload', t, { localPath, remotePath });
}

export async function sftpDownload(t: SftpTarget, remotePath: string, localPath: string): Promise<void> {
  if (!isTauriEnvironment()) return;
  await sftpInvoke('sftp_download', t, { remotePath, localPath });
}

export async function listLocalFiles(localPath: string): Promise<SftpFileEntry[]> {
  if (!isTauriEnvironment()) return DEMO_LOCAL;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<SftpFileEntry[]>('sftp_list_local', { localPath });
}

export async function getLocalHomeDir(): Promise<string> {
  if (!isTauriEnvironment()) return '/home/demo';
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('sftp_get_home_dir');
}

/**
 * Fired after anything that changes what the vault can answer: create,
 * unlock, lock, saving or deleting an entry. Open terminals used to check
 * "is the vault unlocked?" once, when the tab opened -- unlock the vault
 * afterwards and the tab never offered it.
 */
export const VAULT_CHANGED_EVENT = 'plinky:vault-changed';
function notifyVaultChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
}

/** Which vault entry (never its secret) holds a session's password. */
export interface VaultLookup {
  locked: boolean;
  key: string | null;
  hasEnableSecret: boolean;
  /** The entry's username (not a secret), for Telnet/serial Username: prompts. */
  username?: string | null;
  /** Session opt-ins (PlinkyAutoLogin / PlinkyAutoEnable in the session file). */
  autoLogin?: boolean;
  autoEnable?: boolean;
}

export async function vaultLookup(sessionName: string, hostname?: string, username?: string): Promise<VaultLookup> {
  if (!isTauriEnvironment()) return { locked: true, key: null, hasEnableSecret: false, autoLogin: false, autoEnable: false };
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<VaultLookup>('vault_lookup', {
    sessionName,
    hostname: hostname || undefined,
    username: username || undefined,
  });
}

/**
 * Types a vault entry's login or enable password into a session, then Enter.
 * The secret goes from the vault to the session inside the backend -- the
 * webview never holds it -- and a locked vault refuses.
 */
export async function vaultSendSecret(sessionId: string, key: string, field: 'login' | 'enable'): Promise<void> {
  if (!isTauriEnvironment()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('vault_send_secret', { sessionId, key, field });
}

export async function startTerminalSession(
  sessionId: string,
  sessionName: string,
  isLocal: boolean,
  cols: number,
  rows: number,
  onData: (chunk: Uint8Array) => void,
  hostname?: string,
  port?: number,
  username?: string,
  logFileName?: string
): Promise<{ started: boolean; error?: string }> {
  if (isTauriEnvironment()) {
    try {
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<number[]>();
      channel.onmessage = (bytes: number[]) => {
        onData(new Uint8Array(bytes));
      };
      await invoke('start_terminal_session', {
        sessionId,
        sessionName,
        isLocal,
        cols,
        rows,
        onData: channel,
        hostname,
        port,
        username,
        logFileName: logFileName || null,
      });
      return { started: true };
    } catch (e) {
      console.warn("Failed to invoke start_terminal_session via Tauri:", e);
      // The backend's reason ("Failed to open serial line /dev/ttyUSB0: No
      // such file or directory") is the only useful thing to show the user.
      return { started: false, error: String(e) };
    }
  }
  return { started: false };
}

export async function attachTerminalSession(
  sessionId: string,
  fromSeq: number,
  onData: (chunk: Uint8Array) => void
): Promise<AttachInfo | null> {
  if (isTauriEnvironment()) {
    try {
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<number[]>();
      channel.onmessage = (bytes: number[]) => {
        onData(new Uint8Array(bytes));
      };
      const info = await invoke<AttachInfo>('attach_terminal_session', {
        sessionId,
        fromSeq,
        onData: channel,
      });
      return info;
    } catch (e) {
      console.warn("Failed to invoke attach_terminal_session via Tauri:", e);
      return null;
    }
  }
  return null;
}

export async function writeTerminalInput(sessionId: string, data: Uint8Array): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_terminal_input', {
        sessionId,
        data: Array.from(data),
      });
    } catch (e) {
      console.warn("Failed to invoke write_terminal_input via Tauri:", e);
    }
  }
}

export async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('resize_terminal', {
        sessionId,
        cols,
        rows,
      });
    } catch (e) {
      console.warn("Failed to invoke resize_terminal via Tauri:", e);
    }
  }
}

// Tab ids whose session was explicitly closed. A start_terminal_session call
// already in flight when its tab is closed would otherwise create a session
// after the close ran as a no-op -- TerminalView checks this when its start
// resolves late and closes the straggler.
const closedSessionIds = new Set<string>();

export function isSessionClosed(sessionId: string): boolean {
  return closedSessionIds.has(sessionId);
}

export async function closeTerminalSession(sessionId: string): Promise<void> {
  closedSessionIds.add(sessionId);
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_terminal_session', { sessionId });
    } catch (e) {
      console.warn("Failed to invoke close_terminal_session via Tauri:", e);
    }
  }
}

export async function answerHostKeyPrompt(
  sessionId: string,
  answer: 'store' | 'once' | 'reject'
): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('answer_hostkey_prompt', {
        sessionId,
        answer,
      });
      return true;
    } catch (e) {
      console.warn("Failed to answer host key prompt via Tauri:", e);
      return false;
    }
  }
  return true;
}

export async function listenHostKeyPrompts(
  callback: (event: PromptEvent) => void
): Promise<(() => void) | null> {
  if (isTauriEnvironment()) {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<PromptEvent>('session:prompt', (event) => {
        callback(event.payload);
      });
      return unlisten;
    } catch (e) {
      console.warn("Failed to listen for session:prompt via Tauri:", e);
      return null;
    }
  }
  return null;
}

export interface PasteProgress {
  sessionId: string;
  sent: number;
  total: number;
}

/**
 * Pastes text one line at a time with `lineDelayMs` between lines, for
 * console ports / network gear that drop characters on a fast paste. Refused
 * by the backend until the session is Live (never types into a password
 * prompt). Resolves with the number of lines sent; rejects on error.
 */
export async function pastePaced(sessionId: string, text: string, lineDelayMs: number): Promise<number> {
  if (!isTauriEnvironment()) return 0;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<number>('paste_paced', { sessionId, text, lineDelayMs });
}

export async function cancelPaste(sessionId: string): Promise<void> {
  if (!isTauriEnvironment()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('cancel_paste', { sessionId });
}

/**
 * Sends a serial Break (held ~400 ms). Rejects with a message for sessions
 * that aren't serial -- plink has no way to send one (ADR-005).
 */
export async function sendBreak(sessionId: string): Promise<void> {
  if (!isTauriEnvironment()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('send_break', { sessionId });
}

export async function listenPasteProgress(
  callback: (progress: PasteProgress) => void
): Promise<(() => void) | null> {
  if (!isTauriEnvironment()) return null;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<PasteProgress>('paste:progress', (event) => callback(event.payload));
}

export async function setSyncChannel(
  sessionId: string,
  channel: string | null
): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_sync_channel', {
        sessionId,
        channel,
      });
    } catch (e) {
      console.warn("Failed to set sync channel via Tauri:", e);
    }
  }
}

export async function setSyncProtected(
  sessionId: string,
  protectedStatus: boolean
): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_sync_protected', {
        sessionId,
        protected: protectedStatus,
      });
    } catch (e) {
      console.warn("Failed to set sync protection via Tauri:", e);
    }
  }
}

export async function setSyncArmed(armed: boolean): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_sync_armed', { armed });
    } catch (e) {
      console.warn("Failed to set sync armed state via Tauri:", e);
    }
  }
}

export async function broadcastSyncInput(
  channel: string,
  data: Uint8Array
): Promise<number> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<number>('broadcast_sync_input', {
        channel,
        data: Array.from(data),
      });
    } catch (e) {
      console.warn("Failed to broadcast sync input via Tauri:", e);
      return 0;
    }
  }
  return 0;
}

export interface VaultEntry {
  id: string;
  username?: string;
  secret: string;
  enable_secret?: string;
  notes?: string;
  created_at: number;
  updated_at: number;
}

/** Entry metadata WITHOUT the secret -- for listing views. */
export interface VaultEntryMeta {
  id: string;
  username?: string;
  has_enable_secret?: boolean;
  notes?: string;
  created_at: number;
  updated_at: number;
}

/**
 * Exports the whole vault to a KeePass (.kdbx) file chosen in a Save As
 * dialog, protected by the vault's master password -- which is checked
 * against the vault file first. Resolves null if the dialog was cancelled.
 */
export async function vaultExportKdbx(masterPassword: string): Promise<{ path: string; entries: number } | null> {
  if (!isTauriEnvironment()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<{ path: string; entries: number } | null>('vault_export_kdbx', { masterPassword });
}

/**
 * Deletes the vault file permanently (Settings -> Delete vault). Resolves
 * false when there was no vault to delete.
 */
export async function vaultDestroy(): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  const deleted = await invoke<boolean>('vault_destroy');
  notifyVaultChanged();
  return deleted;
}

export async function vaultIsInitialized(): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('vault_is_initialized');
    } catch (e) {
      console.warn("Failed to check vault_is_initialized:", e);
      return false;
    }
  }
  return true;
}

export async function vaultIsUnlocked(): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('vault_is_unlocked');
    } catch (e) {
      console.warn("Failed to check vault_is_unlocked:", e);
      return false;
    }
  }
  return true;
}

export async function vaultCreate(masterPassword: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('vault_create', { masterPassword });
      notifyVaultChanged();
      return true;
    } catch (e) {
      console.error("Failed to create vault:", e);
      throw e;
    }
  }
  return true;
}

export async function vaultUnlock(masterPassword: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('vault_unlock', { masterPassword });
      notifyVaultChanged();
      return true;
    } catch (e) {
      console.error("Failed to unlock vault:", e);
      throw e;
    }
  }
  return true;
}

export async function vaultLock(): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('vault_lock');
      notifyVaultChanged();
      return true;
    } catch (e) {
      console.warn("Failed to lock vault:", e);
      return false;
    }
  }
  return true;
}

export async function vaultGet(key: string): Promise<string | null> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string | null>('vault_get', { key });
    } catch (e) {
      console.warn(`Failed to get key '${key}' from vault:`, e);
      return null;
    }
  }
  return null;
}

export async function vaultSet(key: string, secret: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('vault_set', { key, secret });
      notifyVaultChanged();
      return true;
    } catch (e) {
      console.error(`Failed to set key '${key}' in vault:`, e);
      throw e;
    }
  }
  return true;
}

export async function vaultGetEntry(key: string): Promise<VaultEntry | null> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<VaultEntry | null>('vault_get_entry', { key });
    } catch (e) {
      console.warn(`Failed to get entry '${key}' from vault:`, e);
      return null;
    }
  }
  return null;
}

export async function vaultSetEntry(entry: VaultEntry): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('vault_set_entry', { entry });
      notifyVaultChanged();
      return true;
    } catch (e) {
      console.error(`Failed to set entry '${entry.id}' in vault:`, e);
      throw e;
    }
  }
  return true;
}

export async function vaultDelete(key: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const deleted = await invoke<boolean>('vault_delete', { key });
      notifyVaultChanged();
      return deleted;
    } catch (e) {
      console.warn(`Failed to delete key '${key}' from vault:`, e);
      return false;
    }
  }
  return true;
}

export async function vaultListKeys(): Promise<string[]> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string[]>('vault_list_keys');
    } catch (e) {
      console.warn("Failed to list vault keys:", e);
      return [];
    }
  }
  return [];
}

/** Entry metadata for every stored credential, WITHOUT decrypted secrets.
 * Use vaultGetEntry(id) to fetch one entry's secret on demand -- never
 * bulk-load secrets just to render a list. */
export async function vaultListEntriesMeta(): Promise<VaultEntryMeta[]> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<VaultEntryMeta[]>('vault_list_entries_meta');
    } catch (e) {
      console.warn("Failed to list vault entry metadata:", e);
      return [];
    }
  }
  return [];
}

export async function getShellIntegrationScript(shell: 'bash' | 'zsh' | 'fish'): Promise<string> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string>('get_shell_integration_script', { shell });
    } catch (e) {
      console.warn("Failed to get shell integration script via Tauri:", e);
    }
  }
  return `# Fallback shell integration for ${shell}`;
}

export async function injectShellIntegration(
  sessionId: string,
  shell: 'bash' | 'zsh' | 'fish'
): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('inject_shell_integration', { sessionId, shell });
      return true;
    } catch (e) {
      console.error("Failed to inject shell integration via Tauri:", e);
      return false;
    }
  }
  return true;
}

export interface DetectedSerialPort {
  port_name: string;
  display_name: string;
  is_usb: boolean;
  manufacturer?: string | null;
  product?: string | null;
}

export async function listSerialPorts(): Promise<DetectedSerialPort[]> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DetectedSerialPort[]>('list_serial_ports');
    } catch (e) {
      console.warn("Failed to list serial ports via Tauri:", e);
      return [];
    }
  }
  return [
    { port_name: '/dev/ttyUSB0', display_name: '/dev/ttyUSB0 (FTDI FT232R USB UART)', is_usb: true, manufacturer: 'FTDI', product: 'FT232R USB UART' },
    { port_name: '/dev/ttyACM0', display_name: '/dev/ttyACM0 (Cisco USB Console)', is_usb: true, manufacturer: 'Cisco', product: 'USB Console' },
    { port_name: 'COM3', display_name: 'COM3 (Silicon Labs CP210x)', is_usb: true, manufacturer: 'Silicon Labs', product: 'CP210x' },
    { port_name: '/dev/ttyS0', display_name: '/dev/ttyS0 (Serial Port)', is_usb: false },
  ];
}


