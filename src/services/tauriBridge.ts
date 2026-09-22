import { PuttySession, HostKeyEntry, PpkInfo, SftpFileEntry } from '../types/session';

// Check if running inside Tauri runtime
export const isTauriEnvironment = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

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

export async function listPuttySessions(): Promise<PuttySession[]> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<PuttySession[]>('list_putty_sessions');
    } catch (e) {
      console.warn("Failed to invoke Tauri list_putty_sessions, using fallback:", e);
      return DEMO_SESSIONS;
    }
  }
  // Browser preview mode
  return DEMO_SESSIONS;
}

export async function readPuttySession(name: string): Promise<PuttySession | null> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<PuttySession>('read_putty_session', { name });
    } catch (e) {
      console.warn(`Failed to read session ${name} via Tauri:`, e);
      return DEMO_SESSIONS.find(s => s.name === name) || null;
    }
  }
  return DEMO_SESSIONS.find(s => s.name === name) || null;
}

export async function writePuttySession(session: PuttySession): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_putty_session', { session });
      return true;
    } catch (e) {
      console.error("Failed to write session via Tauri:", e);
      return false;
    }
  }
  const idx = DEMO_SESSIONS.findIndex(s => s.name === session.name);
  if (idx >= 0) {
    DEMO_SESSIONS[idx] = session;
  } else {
    DEMO_SESSIONS.push(session);
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

export async function listRemoteFiles(_sessionName: string, _path: string): Promise<SftpFileEntry[]> {
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
