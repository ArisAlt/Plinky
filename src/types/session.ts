export type Protocol = 'SSH' | 'Serial' | 'Telnet' | 'Rlogin' | 'RAW';

export type SyncChannel = 'A' | 'B' | 'C' | 'D' | 'none';

export type SessionStatus = 'connecting' | 'preauth' | 'live' | 'disconnected';

export interface PuttySession {
  name: string;
  protocol: Protocol;
  hostname: string;
  port: number;
  username?: string;
  publicKeyFile?: string;
  host_name?: string;
  port_number?: number;
  user_name?: string;
  public_key_file?: string;
  log_file_name?: string;
  extra?: Record<string, string>;
  tags?: string[];
  folder?: string;
  lastConnected?: number;
}

export interface TerminalTab {
  id: string;
  title: string;
  sessionName: string;
  syncChannel: SyncChannel;
  status: SessionStatus;
  freeTypeMode: boolean;
  activeHighlighting: boolean;
  hostname: string;
  port: number;
  username?: string;
  protocol?: Protocol;
  vaultKey?: string;
}

export interface TunnelEntry {
  id: string;
  type: 'Local' | 'Remote' | 'Dynamic';
  srcPort: number;
  destHost?: string;
  destPort?: number;
  active: boolean;
  sessionName: string;
  bytesTransferred?: number;
}

export interface SftpFileEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modified: string;
}

export interface SftpTransferItem {
  id: string;
  filename: string;
  direction: 'upload' | 'download';
  size: number;
  transferred: number;
  status: 'queued' | 'transferring' | 'completed' | 'failed';
  error?: string;
}

export interface HostKeyEntry {
  keyType: string;
  port: number;
  hostname: string;
  fingerprint?: string;
  rawKey: string;
}

export interface PpkInfo {
  path: string;
  version: number;
  algorithm: string;
  isEncrypted: boolean;
  comment: string;
  fingerprintSha256: string;
}

export type SplitLayoutMode = 'single' | 'split-vertical' | 'split-horizontal' | 'grid-4' | 'terminal-sftp';

export interface SnippetItem {
  id: string;
  name: string;
  command: string;
  category: 'System' | 'Docker' | 'Logs' | 'Network' | 'Custom';
  description?: string;
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

export interface VaultEntryMeta {
  id: string;
  username?: string;
  has_enable_secret?: boolean;
  notes?: string;
  created_at: number;
  updated_at: number;
}

