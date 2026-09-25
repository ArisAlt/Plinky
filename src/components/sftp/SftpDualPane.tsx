import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SftpFileEntry, SftpTransferItem } from '../../types/session';
import {
  SftpTarget,
  SFTP_ERR_PASSWORD,
  SFTP_ERR_HOSTKEY,
  sftpRemoteHome,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpUpload,
  sftpDownload,
  listLocalFiles,
  getLocalHomeDir,
} from '../../services/tauriBridge';
import {
  Folder,
  File,
  ArrowRight,
  ArrowLeft,
  Upload,
  Download,
  RefreshCw,
  HardDrive,
  Server,
  CheckCircle,
  Loader2,
  Search,
  ChevronRight,
  FolderPlus,
  Trash2,
  X,
  AlertTriangle,
  KeyRound,
} from 'lucide-react';

interface SftpDualPaneProps {
  sessionName: string;
  hostname: string;
  port?: number;
  username?: string;
  initialRemotePath?: string;
  onClose?: () => void;
}

// ---- path helpers -------------------------------------------------------

/**
 * A name the server (or the local disk) gave us, safe to join onto a folder.
 * A malicious server can list "../../.bashrc" or "a/b"; joined as-is, a
 * download would land outside the folder the user chose.
 */
export function isSafeEntryName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

export function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentRemote(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

/** Windows paths use "\" (C:\Users\me); everything else "/". */
function localSep(path: string): string {
  return /^[A-Za-z]:\\/.test(path) || (path.includes('\\') && !path.includes('/')) ? '\\' : '/';
}

export function joinLocal(dir: string, name: string): string {
  const sep = localSep(dir);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function parentLocal(path: string): string {
  const sep = localSep(path);
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) return path;
  const parent = trimmed.slice(0, idx);
  if (sep === '\\' && /^[A-Za-z]:$/.test(parent)) return parent + '\\'; // C:\
  return parent || '/';
}

function isRoot(path: string): boolean {
  return path === '/' || /^[A-Za-z]:\\?$/.test(path);
}

/** Error text for display: without the tag the pane uses to decide what to offer. */
function displayError(e: unknown): string {
  return String(e).replace(SFTP_ERR_PASSWORD, '').replace(SFTP_ERR_HOSTKEY, '');
}

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const PARENT: SftpFileEntry = {
  name: '..', isDir: true, isSymlink: false, size: 0, permissions: '', owner: '', group: '', modified: '',
};

/** Sorted listing with our own ".." row (the backends disagree on including one). */
function withParent(entries: SftpFileEntry[], atRoot: boolean): SftpFileEntry[] {
  const rest = entries
    .filter(e => e.name !== '.' && e.name !== '..')
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return atRoot ? rest : [PARENT, ...rest];
}

// ---- component ----------------------------------------------------------

export const SftpDualPane: React.FC<SftpDualPaneProps> = ({
  sessionName, hostname, port, username, initialRemotePath, onClose,
}) => {
  const [viewMode, setViewMode] = useState<'dual' | 'remote' | 'local'>('dual');

  // A password typed here lives only while the pane is open, and only for
  // the server it was typed for: it's stored with that server's identity,
  // so switching sessions can never send it to a different host. Saved
  // sessions with a vault entry don't need it -- the backend reads the vault.
  const sessionKey = `${sessionName}|${hostname}|${port ?? ''}|${username ?? ''}`;
  const [typedPassword, setTypedPassword] = useState<{ key: string; value: string } | null>(null);
  const [passwordDraft, setPasswordDraft] = useState('');
  const password = typedPassword?.key === sessionKey ? typedPassword.value : undefined;
  const target: SftpTarget = { sessionName, hostname, port, username, password };

  const [remotePath, setRemotePath] = useState<string | null>(initialRemotePath || null);
  const [remoteDraft, setRemoteDraft] = useState(initialRemotePath || '');
  const [remoteFiles, setRemoteFiles] = useState<SftpFileEntry[]>([]);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);

  const [localPath, setLocalPath] = useState<string | null>(null);
  const [localDraft, setLocalDraft] = useState('');
  const [localFiles, setLocalFiles] = useState<SftpFileEntry[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  const [localFilter, setLocalFilter] = useState('');
  const [remoteFilter, setRemoteFilter] = useState('');
  const [selectedLocal, setSelectedLocal] = useState<string | null>(null);
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<'local' | 'remote' | null>(null);
  const [transfers, setTransfers] = useState<SftpTransferItem[]>([]);

  // Each psftp call is a fresh connection taking ~0.5 s; navigating quickly
  // could let an older listing land after a newer one. Only the latest wins.
  const remoteSeq = useRef(0);
  const localSeq = useRef(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const loadRemote = useCallback(async (path: string | null, t: SftpTarget) => {
    const seq = ++remoteSeq.current;
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      // No path yet: start where psftp does, in the user's home.
      const dir = path ?? await sftpRemoteHome(t);
      const files = await sftpList(t, dir);
      if (seq !== remoteSeq.current) return;
      setRemotePath(dir);
      setRemoteDraft(dir);
      setRemoteFiles(withParent(files, dir === '/'));
    } catch (e) {
      if (seq !== remoteSeq.current) return;
      setRemoteError(String(e));
    } finally {
      if (seq === remoteSeq.current) setRemoteLoading(false);
    }
  }, []);

  const loadLocal = useCallback(async (path: string | null) => {
    const seq = ++localSeq.current;
    setLocalError(null);
    try {
      const dir = path ?? await getLocalHomeDir();
      const files = await listLocalFiles(dir);
      if (seq !== localSeq.current) return;
      setLocalPath(dir);
      setLocalDraft(dir);
      setLocalFiles(withParent(files, isRoot(dir)));
    } catch (e) {
      if (seq === localSeq.current) setLocalError(String(e));
    }
  }, []);

  // A different session starts over on the new server.
  useEffect(() => {
    setRemoteFiles([]);
    setSelectedRemote(null);
    setPasswordDraft('');
    void loadRemote(initialRemotePath || null, target);
  }, [sessionKey, initialRemotePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry with a password just typed into the prompt.
  useEffect(() => {
    if (password) void loadRemote(remotePath, target);
  }, [typedPassword]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void loadLocal(null); }, [loadLocal]);

  const openRemote = (entry: SftpFileEntry) => {
    if (remotePath === null) return;
    if (entry.name === '..') return void loadRemote(parentRemote(remotePath), target);
    if (entry.isDir && isSafeEntryName(entry.name)) return void loadRemote(joinRemote(remotePath, entry.name), target);
    if (!entry.isDir) void download(entry);
    setSelectedRemote(null);
  };

  const openLocal = (entry: SftpFileEntry) => {
    if (localPath === null) return;
    if (entry.name === '..') return void loadLocal(parentLocal(localPath));
    if (entry.isDir) return void loadLocal(joinLocal(localPath, entry.name));
    void upload(entry);
    setSelectedLocal(null);
  };

  const runTransfer = async (
    direction: 'upload' | 'download',
    entry: SftpFileEntry,
    work: () => Promise<void>,
    after: () => Promise<void>,
  ) => {
    const id = `${direction}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    // psftp reports no progress in batch mode, so a transfer is shown as
    // running until it really finishes -- never an invented percentage.
    setTransfers(prev => [{ id, filename: entry.name, direction, size: entry.size, transferred: 0, status: 'transferring' }, ...prev]);
    try {
      await work();
      setTransfers(prev => prev.map(t => (t.id === id ? { ...t, status: 'completed', transferred: t.size } : t)));
      await after();
    } catch (e) {
      setTransfers(prev => prev.map(t => (t.id === id ? { ...t, status: 'failed', error: displayError(e) } : t)));
    }
  };

  const upload = async (entry: SftpFileEntry) => {
    if (entry.isDir || localPath === null || remotePath === null) return;
    if (!isSafeEntryName(entry.name)) return;
    if (remoteFiles.some(f => f.name === entry.name) && !confirm(`Replace "${entry.name}" on the server?`)) return;
    const dest = joinRemote(remotePath, entry.name);
    const src = joinLocal(localPath, entry.name);
    const dir = remotePath;
    await runTransfer('upload', entry, () => sftpUpload(target, src, dest), () => loadRemote(dir, target));
  };

  const download = async (entry: SftpFileEntry) => {
    if (entry.isDir || localPath === null || remotePath === null) return;
    if (!isSafeEntryName(entry.name)) {
      setRemoteError(`Refusing to download a file named "${entry.name}": it would land outside ${localPath}`);
      return;
    }
    if (localFiles.some(f => f.name === entry.name) && !confirm(`Replace local "${entry.name}"?`)) return;
    const src = joinRemote(remotePath, entry.name);
    const dest = joinLocal(localPath, entry.name);
    const dir = localPath;
    await runTransfer('download', entry, () => sftpDownload(target, src, dest), () => loadLocal(dir));
  };

  const handleUploadSelected = () => {
    const entry = localFiles.find(f => f.name === selectedLocal);
    if (entry) void upload(entry);
  };

  const handleDownloadSelected = () => {
    const entry = remoteFiles.find(f => f.name === selectedRemote);
    if (entry) void download(entry);
  };

  const handleCreateRemoteFolder = async () => {
    if (remotePath === null) return;
    const name = prompt('New folder name:')?.trim();
    if (!name) return;
    if (!isSafeEntryName(name)) {
      setRemoteError(`"${name}" isn't a valid folder name`);
      return;
    }
    try {
      await sftpMkdir(target, joinRemote(remotePath, name));
      await loadRemote(remotePath, target);
    } catch (e) {
      setRemoteError(String(e));
    }
  };

  const handleDeleteRemoteItem = async () => {
    const entry = remoteFiles.find(f => f.name === selectedRemote);
    if (!entry || entry.name === '..' || remotePath === null) return;
    const what = entry.isDir ? 'folder (must be empty)' : 'file';
    if (!confirm(`Delete the ${what} "${entry.name}" on ${sessionName}?`)) return;
    try {
      await sftpRemove(target, joinRemote(remotePath, entry.name), entry.isDir);
      setSelectedRemote(null);
      await loadRemote(remotePath, target);
    } catch (e) {
      setRemoteError(String(e));
    }
  };

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setTypedPassword({ key: sessionKey, value: passwordDraft });
  };

  // Dragging a row from one pane onto the other transfers it.
  const onRowDragStart = (side: 'local' | 'remote', entry: SftpFileEntry) => (e: React.DragEvent) => {
    if (entry.isDir) return e.preventDefault();
    e.dataTransfer.setData('application/x-plinky-sftp', JSON.stringify({ side, name: entry.name }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const dropOn = (side: 'local' | 'remote') => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-plinky-sftp')) return;
      e.preventDefault();
      if (dragOver !== side) setDragOver(side);
    },
    onDragLeave: () => setDragOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      try {
        const { side: from, name } = JSON.parse(e.dataTransfer.getData('application/x-plinky-sftp'));
        if (from === 'local' && side === 'remote') {
          const entry = localFiles.find(f => f.name === name);
          if (entry) void upload(entry);
        } else if (from === 'remote' && side === 'local') {
          const entry = remoteFiles.find(f => f.name === name);
          if (entry) void download(entry);
        }
      } catch {
        // not one of our rows
      }
    },
  });

  const renderBreadcrumbs = (path: string | null, onSelect: (p: string) => void) => {
    if (!path || localSep(path) === '\\') return <div className="text-[11px] font-mono text-slate-500 truncate">{path}</div>;
    const parts = path.split('/').filter(Boolean);
    return (
      <div className="flex items-center space-x-1 text-slate-400 overflow-x-auto text-[11px] font-mono py-0.5">
        <button onClick={() => onSelect('/')} className="hover:text-sky-300 font-semibold transition">/</button>
        {parts.map((part, index) => {
          const subPath = '/' + parts.slice(0, index + 1).join('/');
          const isLast = index === parts.length - 1;
          return (
            <React.Fragment key={subPath}>
              <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />
              <button
                onClick={() => onSelect(subPath)}
                className={`hover:text-sky-300 transition truncate max-w-[100px] ${isLast ? 'text-slate-200 font-medium' : ''}`}
              >
                {part}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  const renderRows = (
    side: 'local' | 'remote',
    files: SftpFileEntry[],
    filter: string,
    selected: string | null,
    select: (n: string) => void,
    open: (e: SftpFileEntry) => void,
  ) =>
    files
      .filter(f => f.name === '..' || f.name.toLowerCase().includes(filter.toLowerCase()))
      .map(file => (
        <tr
          key={file.name}
          draggable={!file.isDir}
          onDragStart={onRowDragStart(side, file)}
          onClick={() => select(file.name)}
          onDoubleClick={() => open(file)}
          title={file.isDir ? 'Double-click to open' : `Double-click to ${side === 'local' ? 'upload' : 'download'}`}
          className={`cursor-pointer hover:bg-plinky-800/50 transition ${
            selected === file.name ? (side === 'local' ? 'bg-sky-500/20 text-sky-200' : 'bg-emerald-500/20 text-emerald-200') : ''
          }`}
        >
          <td className="py-1 px-2 flex items-center space-x-1.5">
            {file.isDir ? <Folder className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" /> : <File className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
            <span className="truncate">{file.name}</span>
          </td>
          <td className="py-1 px-2 text-slate-400 font-mono text-[11px]">{file.isDir ? '-' : formatSize(file.size)}</td>
          {side === 'remote' && <td className="py-1 px-2 text-slate-500 font-mono text-[10px]">{file.permissions}</td>}
          <td className="py-1 px-2 text-slate-500 text-[11px] truncate">{file.modified}</td>
        </tr>
      ));

  const needsPassword = !!remoteError?.startsWith(SFTP_ERR_PASSWORD);
  const selectedLocalEntry = localFiles.find(f => f.name === selectedLocal);
  const selectedRemoteEntry = remoteFiles.find(f => f.name === selectedRemote);

  return (
    <div className="flex flex-col h-full bg-plinky-950 text-slate-200 select-none text-xs">
      {/* Header */}
      <div className="flex items-center justify-between p-2.5 bg-plinky-900 border-b border-plinky-800">
        <div className="flex items-center space-x-2 min-w-0">
          <Server className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <span className="font-semibold text-slate-200 truncate">SFTP: {sessionName}</span>
          {hostname && <span className="text-slate-500 font-mono truncate">({username ? `${username}@` : ''}{hostname})</span>}
        </div>
        <div className="flex items-center space-x-2">
          <div className="flex items-center bg-plinky-950 p-0.5 rounded border border-plinky-800 text-[10px]">
            {(['dual', 'remote', 'local'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-1.5 py-0.5 rounded transition capitalize ${viewMode === mode ? 'bg-plinky-800 text-sky-300 font-medium' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {mode}
              </button>
            ))}
          </div>
          <button
            onClick={() => { void loadRemote(remotePath, target); void loadLocal(localPath); }}
            className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-slate-200 transition"
            title="Refresh both panes"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${remoteLoading ? 'animate-spin text-sky-400' : ''}`} />
          </button>
          {onClose && (
            <button onClick={onClose} title="Close SFTP (Esc)" className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-white transition ml-1">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Local */}
        {(viewMode === 'dual' || viewMode === 'local') && (
          <div className="flex-1 flex flex-col border-r border-plinky-800 min-w-0">
            <div className="p-2 bg-plinky-900/60 border-b border-plinky-800 space-y-1.5">
              <form className="flex items-center space-x-1.5" onSubmit={e => { e.preventDefault(); void loadLocal(localDraft.trim() || null); }}>
                <HardDrive className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                <span className="font-medium text-slate-300">Local:</span>
                <input
                  type="text"
                  value={localDraft}
                  onChange={e => setLocalDraft(e.target.value)}
                  title="Type a path and press Enter"
                  className="flex-1 min-w-0 bg-plinky-950 border border-plinky-700/60 rounded px-2 py-0.5 text-xs text-slate-300 font-mono"
                />
              </form>
              <div className="flex items-center justify-between">
                {renderBreadcrumbs(localPath, p => void loadLocal(p))}
                <div className="relative flex items-center w-28 flex-shrink-0">
                  <Search className="w-3 h-3 absolute left-1.5 text-slate-500" />
                  <input type="text" placeholder="Filter..." value={localFilter} onChange={e => setLocalFilter(e.target.value)}
                    className="w-full pl-5 pr-1 py-0.5 bg-plinky-950 border border-plinky-700/60 rounded text-[10px] text-slate-300" />
                </div>
              </div>
            </div>
            {localError && (
              <div className="m-2 p-2 rounded border border-red-500/40 bg-red-950/40 text-red-300 text-[11px] flex items-start space-x-1.5">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /><span>{displayError(localError)}</span>
              </div>
            )}
            <div {...dropOn('local')} className={`flex-1 overflow-y-auto relative ${dragOver === 'local' ? 'outline outline-2 outline-dashed outline-sky-400 -outline-offset-4' : ''}`}>
              <table className="w-full text-left border-collapse">
                <thead className="bg-plinky-900/40 text-slate-500 text-[11px] sticky top-0">
                  <tr>
                    <th className="py-1 px-2 font-medium">Name</th>
                    <th className="py-1 px-2 font-medium w-20">Size</th>
                    <th className="py-1 px-2 font-medium w-24">Modified</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-plinky-800/40">
                  {renderRows('local', localFiles, localFilter, selectedLocal, setSelectedLocal, openLocal)}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Transfer buttons */}
        {viewMode === 'dual' && (
          <div className="w-10 bg-plinky-900/80 border-r border-plinky-800 flex flex-col items-center justify-center space-y-3">
            <button
              onClick={handleUploadSelected}
              disabled={!selectedLocalEntry || selectedLocalEntry.isDir || remotePath === null}
              title="Upload the selected file"
              className="p-1.5 rounded bg-sky-600/30 hover:bg-sky-600/50 text-sky-300 disabled:opacity-30 disabled:pointer-events-none transition"
            >
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={handleDownloadSelected}
              disabled={!selectedRemoteEntry || selectedRemoteEntry.isDir || localPath === null}
              title="Download the selected file"
              className="p-1.5 rounded bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 disabled:opacity-30 disabled:pointer-events-none transition"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Remote */}
        {(viewMode === 'dual' || viewMode === 'remote') && (
          <div className="flex-1 flex flex-col min-w-0">
            <div className="p-2 bg-plinky-900/60 border-b border-plinky-800 space-y-1.5">
              <form className="flex items-center space-x-1.5" onSubmit={e => { e.preventDefault(); void loadRemote(remoteDraft.trim() || null, target); }}>
                <Server className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                <span className="font-medium text-slate-300">Remote:</span>
                <input
                  type="text"
                  value={remoteDraft}
                  onChange={e => setRemoteDraft(e.target.value)}
                  placeholder={remoteLoading ? 'Connecting…' : ''}
                  title="Type a path and press Enter"
                  className="flex-1 min-w-0 bg-plinky-950 border border-plinky-700/60 rounded px-2 py-0.5 text-xs text-slate-300 font-mono"
                />
              </form>
              <div className="flex items-center justify-between">
                {renderBreadcrumbs(remotePath, p => void loadRemote(p, target))}
                <div className="flex items-center space-x-1.5 flex-shrink-0">
                  <button onClick={handleCreateRemoteFolder} disabled={remotePath === null}
                    className="p-1 rounded bg-plinky-800 hover:bg-plinky-700 text-slate-300 hover:text-white disabled:opacity-30 transition" title="New remote folder">
                    <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
                  </button>
                  <button onClick={handleDeleteRemoteItem} disabled={!selectedRemoteEntry || selectedRemote === '..'}
                    className="p-1 rounded bg-plinky-800 hover:bg-red-500/20 text-slate-300 hover:text-red-400 disabled:opacity-30 disabled:pointer-events-none transition" title="Delete the selected remote item">
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </button>
                  <div className="relative flex items-center w-28">
                    <Search className="w-3 h-3 absolute left-1.5 text-slate-500" />
                    <input type="text" placeholder="Filter..." value={remoteFilter} onChange={e => setRemoteFilter(e.target.value)}
                      className="w-full pl-5 pr-1 py-0.5 bg-plinky-950 border border-plinky-700/60 rounded text-[10px] text-slate-300" />
                  </div>
                </div>
              </div>
            </div>

            {remoteError && (
              <div className="m-2 p-2 rounded border border-red-500/40 bg-red-950/40 text-red-300 text-[11px] space-y-2" role="alert">
                <div className="flex items-start space-x-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                  <span className="select-text">{displayError(remoteError)}</span>
                </div>
                {needsPassword && (
                  <form onSubmit={submitPassword} className="flex items-center space-x-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                    <input
                      type="password"
                      autoFocus
                      value={passwordDraft}
                      onChange={e => setPasswordDraft(e.target.value)}
                      placeholder={`Password for ${username ? `${username}@` : ''}${hostname || sessionName}`}
                      className="flex-1 min-w-0 bg-plinky-950 border border-plinky-700 rounded px-2 py-0.5 text-xs text-slate-200"
                    />
                    <button type="submit" disabled={!passwordDraft} className="px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40">
                      Connect
                    </button>
                  </form>
                )}
              </div>
            )}

            <div {...dropOn('remote')} className={`flex-1 overflow-y-auto relative ${dragOver === 'remote' ? 'outline outline-2 outline-dashed outline-emerald-400 -outline-offset-4' : ''}`}>
              {remoteLoading && remoteFiles.length === 0 && !remoteError && (
                <div className="flex items-center justify-center py-8 text-slate-500 space-x-2">
                  <Loader2 className="w-4 h-4 animate-spin" /><span>Connecting to {hostname || sessionName}…</span>
                </div>
              )}
              <table className="w-full text-left border-collapse">
                <thead className="bg-plinky-900/40 text-slate-500 text-[11px] sticky top-0">
                  <tr>
                    <th className="py-1 px-2 font-medium">Name</th>
                    <th className="py-1 px-2 font-medium w-20">Size</th>
                    <th className="py-1 px-2 font-medium w-20">Perms</th>
                    <th className="py-1 px-2 font-medium w-24">Modified</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-plinky-800/40">
                  {renderRows('remote', remoteFiles, remoteFilter, selectedRemote, setSelectedRemote, openRemote)}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Transfers */}
      <div className="h-28 bg-plinky-900 border-t border-plinky-800 flex flex-col">
        <div className="px-3 py-1 bg-plinky-950/60 border-b border-plinky-800 flex items-center justify-between text-[11px] text-slate-400">
          <span className="font-semibold text-slate-300">Transfers ({transfers.length})</span>
          {transfers.some(t => t.status !== 'transferring') && (
            <button onClick={() => setTransfers(prev => prev.filter(t => t.status === 'transferring'))} className="text-[10px] hover:text-slate-200">
              Clear finished
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {transfers.length === 0 && (
            <div className="text-slate-600 text-[11px] text-center pt-3">
              Double-click a file, use the arrows, or drag it to the other pane.
            </div>
          )}
          {transfers.map(item => (
            <div key={item.id} className="flex items-center space-x-2 text-xs bg-plinky-950 p-1.5 rounded border border-plinky-800/60">
              {item.direction === 'upload' ? <Upload className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" /> : <Download className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />}
              <span className="font-medium text-slate-200 truncate w-40 flex-shrink-0">{item.filename}</span>
              <span className="font-mono text-[11px] text-slate-500 w-16 flex-shrink-0">{formatSize(item.size)}</span>
              <span className={`flex-1 truncate text-[11px] ${item.status === 'failed' ? 'text-red-400 select-text' : 'text-slate-400'}`} title={item.error}>
                {item.status === 'transferring' ? 'Transferring…' : item.status === 'completed' ? 'Done' : item.error}
              </span>
              {item.status === 'completed' && <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />}
              {item.status === 'transferring' && <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin flex-shrink-0" />}
              {item.status === 'failed' && <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
