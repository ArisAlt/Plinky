import { PuttySession, HostKeyEntry, PpkInfo, SftpFileEntry, TunnelEntry } from '../types/session';

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
    protocol: (raw.protocol || 'SSH').toUpperCase() as any,
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
  }

  const payload = {
    name: session.name,
    host_name: session.hostname || session.host_name || '',
    port_number: session.port || session.port_number || 22,
    user_name: session.username || session.user_name || '',
    protocol: (session.protocol || 'ssh').toLowerCase(),
    public_key_file: session.publicKeyFile || session.public_key_file || '',
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

export async function listRemoteFiles(
  sessionName: string, 
  path: string,
  hostname?: string,
  port?: number,
  username?: string
): Promise<SftpFileEntry[]> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<SftpFileEntry[]>('sftp_list', {
        sessionName,
        remotePath: path,
        hostname: hostname || undefined,
        port: port || undefined,
        username: username || undefined,
      });
    } catch (e) {
      console.warn("Failed to invoke sftp_list via Tauri:", e);
    }
  }
  // Mock SFTP remote filesystem listing
  return [
    { name: "..", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "root", group: "root", modified: "Sep 22 18:00" },
    { name: "etc", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "root", group: "root", modified: "Sep 22 18:05" },
    { name: "var", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "root", group: "root", modified: "Sep 22 18:05" },
    { name: "home", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "root", group: "root", modified: "Sep 22 18:06" },
    { name: "deploy", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "deploy", group: "deploy", modified: "Sep 22 19:30" },
    { name: "app.log", isDir: false, isSymlink: false, size: 2048590, permissions: "-rw-r--r--", owner: "deploy", group: "deploy", modified: "Sep 22 20:15" },
    { name: "nginx.conf", isDir: false, isSymlink: false, size: 3412, permissions: "-rw-r--r--", owner: "root", group: "root", modified: "Sep 20 11:22" },
    { name: "docker-compose.yml", isDir: false, isSymlink: false, size: 1820, permissions: "-rw-r--r--", owner: "deploy", group: "deploy", modified: "Sep 21 14:10" },
    { name: "backup.tar.gz", isDir: false, isSymlink: false, size: 45182900, permissions: "-rw-------", owner: "root", group: "root", modified: "Sep 19 04:00" },
  ];
}

export async function createRemoteDir(
  sessionName: string, 
  path: string,
  hostname?: string,
  port?: number,
  username?: string
): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('sftp_mkdir', {
        sessionName,
        remotePath: path,
        hostname: hostname || undefined,
        port: port || undefined,
        username: username || undefined,
      });
      return true;
    } catch (e) {
      console.warn("Failed to invoke sftp_mkdir via Tauri:", e);
      return false;
    }
  }
  return true;
}

export async function removeRemoteFile(
  sessionName: string, 
  path: string,
  hostname?: string,
  port?: number,
  username?: string
): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('sftp_rm', {
        sessionName,
        remotePath: path,
        hostname: hostname || undefined,
        port: port || undefined,
        username: username || undefined,
      });
      return true;
    } catch (e) {
      console.warn("Failed to invoke sftp_rm via Tauri:", e);
      return false;
    }
  }
  return true;
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
): Promise<boolean> {
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
      return true;
    } catch (e) {
      console.warn("Failed to invoke start_terminal_session via Tauri:", e);
      return false;
    }
  }
  return false;
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

export async function closeTerminalSession(sessionId: string): Promise<void> {
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
  notes?: string;
  created_at: number;
  updated_at: number;
}

/** Entry metadata WITHOUT the secret -- for listing views. */
export interface VaultEntryMeta {
  id: string;
  username?: string;
  notes?: string;
  created_at: number;
  updated_at: number;
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
      return await invoke<boolean>('vault_delete', { key });
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


