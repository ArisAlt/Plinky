import React, { useState, useEffect } from 'react';
import { SftpFileEntry, SftpTransferItem } from '../../types/session';
import { listRemoteFiles, createRemoteDir, removeRemoteFile } from '../../services/tauriBridge';
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
  Clock,
  Search,
  ChevronRight,
  FolderPlus,
  Trash2
} from 'lucide-react';

interface SftpDualPaneProps {
  sessionName: string;
  hostname: string;
}

export const SftpDualPane: React.FC<SftpDualPaneProps> = ({ sessionName, hostname }) => {
  const [remotePath, setRemotePath] = useState('/var/www');
  const [localPath, setLocalPath] = useState('/home/user/workspace');
  const [localFilter, setLocalFilter] = useState('');
  const [remoteFilter, setRemoteFilter] = useState('');

  const [remoteFiles, setRemoteFiles] = useState<SftpFileEntry[]>([]);
  const [localFiles, setLocalFiles] = useState<SftpFileEntry[]>([
    { name: "..", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "user", group: "user", modified: "Sep 22 20:00" },
    { name: "build", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "user", group: "user", modified: "Sep 22 20:10" },
    { name: "src", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "user", group: "user", modified: "Sep 22 20:12" },
    { name: "public", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "user", group: "user", modified: "Sep 22 19:30" },
    { name: "package.json", isDir: false, isSymlink: false, size: 1250, permissions: "-rw-r--r--", owner: "user", group: "user", modified: "Sep 22 19:40" },
    { name: "bundle.js", isDir: false, isSymlink: false, size: 342000, permissions: "-rw-r--r--", owner: "user", group: "user", modified: "Sep 22 20:14" },
    { name: "README.md", isDir: false, isSymlink: false, size: 4520, permissions: "-rw-r--r--", owner: "user", group: "user", modified: "Sep 22 18:22" },
  ]);

  const [selectedLocal, setSelectedLocal] = useState<string | null>(null);
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<SftpTransferItem[]>([
    { id: '1', filename: 'nginx.conf', direction: 'download', size: 3412, transferred: 3412, status: 'completed' },
    { id: '2', filename: 'bundle.js', direction: 'upload', size: 342000, transferred: 215000, status: 'transferring' },
  ]);

  useEffect(() => {
    loadRemoteFiles();
  }, [sessionName, remotePath]);

  const loadRemoteFiles = async () => {
    const files = await listRemoteFiles(sessionName, remotePath);
    // Ensure parent directory ".." exists
    if (!files.some(f => f.name === '..')) {
      setRemoteFiles([
        { name: "..", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "root", group: "root", modified: "Sep 22 20:00" },
        ...files
      ]);
    } else {
      setRemoteFiles(files);
    }
  };

  const handleNavigateLocal = (entry: SftpFileEntry) => {
    if (!entry.isDir) return;
    if (entry.name === '..') {
      const parts = localPath.split('/').filter(Boolean);
      parts.pop();
      setLocalPath('/' + parts.join('/'));
      setLocalFiles([
        { name: "..", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "user", group: "user", modified: "Sep 22 20:00" },
        { name: "build", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "user", group: "user", modified: "Sep 22 20:10" },
        { name: "src", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "user", group: "user", modified: "Sep 22 20:12" },
        { name: "package.json", isDir: false, isSymlink: false, size: 1250, permissions: "-rw-r--r--", owner: "user", group: "user", modified: "Sep 22 19:40" },
      ]);
    } else {
      setLocalPath(localPath.endsWith('/') ? `${localPath}${entry.name}` : `${localPath}/${entry.name}`);
      setLocalFiles([
        { name: "..", isDir: true, isSymlink: false, size: 4096, permissions: "drwxr-xr-x", owner: "user", group: "user", modified: "Sep 22 20:00" },
        { name: "index.ts", isDir: false, isSymlink: false, size: 2400, permissions: "-rw-r--r--", owner: "user", group: "user", modified: "Sep 22 20:15" },
        { name: "config.json", isDir: false, isSymlink: false, size: 840, permissions: "-rw-r--r--", owner: "user", group: "user", modified: "Sep 22 20:16" },
      ]);
    }
    setSelectedLocal(null);
  };

  const handleNavigateRemote = (entry: SftpFileEntry) => {
    if (!entry.isDir) return;
    if (entry.name === '..') {
      const parts = remotePath.split('/').filter(Boolean);
      parts.pop();
      setRemotePath('/' + parts.join('/'));
    } else {
      setRemotePath(remotePath.endsWith('/') ? `${remotePath}${entry.name}` : `${remotePath}/${entry.name}`);
    }
    setSelectedRemote(null);
  };

  const handleUpload = () => {
    if (!selectedLocal) return;
    const file = localFiles.find(f => f.name === selectedLocal);
    if (!file || file.isDir) return;

    const newItem: SftpTransferItem = {
      id: Date.now().toString(),
      filename: file.name,
      direction: 'upload',
      size: file.size,
      transferred: file.size,
      status: 'completed',
    };
    setTransfers(prev => [newItem, ...prev]);
  };

  const handleCreateRemoteFolder = async () => {
    const dirName = prompt("Enter new remote folder name:");
    if (!dirName || !dirName.trim()) return;
    const cleanPath = remotePath.endsWith('/') ? `${remotePath}${dirName.trim()}` : `${remotePath}/${dirName.trim()}`;
    const ok = await createRemoteDir(sessionName, cleanPath);
    if (ok) {
      await loadRemoteFiles();
    }
  };

  const handleDeleteRemoteItem = async () => {
    if (!selectedRemote || selectedRemote === '..') return;
    if (!confirm(`Are you sure you want to delete "${selectedRemote}" on ${sessionName}?`)) return;
    const cleanPath = remotePath.endsWith('/') ? `${remotePath}${selectedRemote}` : `${remotePath}/${selectedRemote}`;
    const ok = await removeRemoteFile(sessionName, cleanPath);
    if (ok) {
      setSelectedRemote(null);
      await loadRemoteFiles();
    }
  };

  const handleDownload = () => {
    if (!selectedRemote) return;
    const file = remoteFiles.find(f => f.name === selectedRemote);
    if (!file || file.isDir) return;

    const newItem: SftpTransferItem = {
      id: Date.now().toString(),
      filename: file.name,
      direction: 'download',
      size: file.size,
      transferred: file.size,
      status: 'completed',
    };
    setTransfers(prev => [newItem, ...prev]);
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const renderBreadcrumbs = (path: string, onSelect: (newPath: string) => void) => {
    const parts = path.split('/').filter(Boolean);
    return (
      <div className="flex items-center space-x-1 text-slate-400 overflow-x-auto text-[11px] font-mono py-0.5">
        <button
          onClick={() => onSelect('/')}
          className="hover:text-sky-300 font-semibold transition"
        >
          /
        </button>
        {parts.map((part, index) => {
          const subPath = '/' + parts.slice(0, index + 1).join('/');
          const isLast = index === parts.length - 1;
          return (
            <React.Fragment key={subPath}>
              <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />
              <button
                onClick={() => onSelect(subPath)}
                className={`hover:text-sky-300 transition truncate max-w-[100px] ${
                  isLast ? 'text-slate-200 font-medium' : ''
                }`}
              >
                {part}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  const filteredLocal = localFiles.filter(f => 
    f.name === '..' || f.name.toLowerCase().includes(localFilter.toLowerCase())
  );

  const filteredRemote = remoteFiles.filter(f => 
    f.name === '..' || f.name.toLowerCase().includes(remoteFilter.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full bg-plinky-950 text-slate-200 select-none text-xs">
      {/* SFTP Top Header */}
      <div className="flex items-center justify-between p-2.5 bg-plinky-900 border-b border-plinky-800">
        <div className="flex items-center space-x-2">
          <Server className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-slate-200">SFTP Dual-Pane: {sessionName}</span>
          <span className="text-slate-500 font-mono">({hostname})</span>
        </div>
        <div className="flex items-center space-x-2">
          <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[11px] font-mono">
            Plain psftp (ADR-003)
          </span>
          <button
            onClick={loadRemoteFiles}
            className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-slate-200 transition"
            title="Refresh Directory"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Dual-Pane Filesystem Canvas */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Local Filesystem */}
        <div className="flex-1 flex flex-col border-r border-plinky-800">
          {/* Local Path Input & Breadcrumbs */}
          <div className="p-2 bg-plinky-900/60 border-b border-plinky-800 space-y-1.5">
            <div className="flex items-center space-x-1.5">
              <HardDrive className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
              <span className="font-medium text-slate-300">Local:</span>
              <input
                type="text"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                className="flex-1 bg-plinky-950 border border-plinky-700/60 rounded px-2 py-0.5 text-xs text-slate-300 font-mono"
              />
            </div>
            <div className="flex items-center justify-between">
              {renderBreadcrumbs(localPath, setLocalPath)}
              <div className="relative flex items-center w-28">
                <Search className="w-3 h-3 absolute left-1.5 text-slate-500" />
                <input
                  type="text"
                  placeholder="Filter..."
                  value={localFilter}
                  onChange={(e) => setLocalFilter(e.target.value)}
                  className="w-full pl-5 pr-1 py-0.5 bg-plinky-950 border border-plinky-700/60 rounded text-[10px] text-slate-300"
                />
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="bg-plinky-900/40 text-slate-500 text-[11px] sticky top-0">
                <tr>
                  <th className="py-1 px-2 font-medium">Name</th>
                  <th className="py-1 px-2 font-medium w-20">Size</th>
                  <th className="py-1 px-2 font-medium w-24">Modified</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-plinky-800/40">
                {filteredLocal.map((file) => (
                  <tr
                    key={file.name}
                    onClick={() => setSelectedLocal(file.name)}
                    onDoubleClick={() => handleNavigateLocal(file)}
                    className={`cursor-pointer hover:bg-plinky-800/50 transition ${
                      selectedLocal === file.name ? 'bg-sky-500/20 text-sky-200' : ''
                    }`}
                  >
                    <td className="py-1 px-2 flex items-center space-x-1.5">
                      {file.isDir ? (
                        <Folder className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                      ) : (
                        <File className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      )}
                      <span className="truncate">{file.name}</span>
                    </td>
                    <td className="py-1 px-2 text-slate-400 font-mono text-[11px]">
                      {file.isDir ? '-' : formatSize(file.size)}
                    </td>
                    <td className="py-1 px-2 text-slate-500 text-[11px] truncate">
                      {file.modified}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Center Transfer Action Column */}
        <div className="w-10 bg-plinky-900/80 border-r border-plinky-800 flex flex-col items-center justify-center space-y-3">
          <button
            onClick={handleUpload}
            disabled={!selectedLocal}
            title="Upload Selected File to Remote"
            className="p-1.5 rounded bg-sky-600/30 hover:bg-sky-600/50 text-sky-300 disabled:opacity-30 disabled:pointer-events-none transition"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={handleDownload}
            disabled={!selectedRemote}
            title="Download Selected File to Local"
            className="p-1.5 rounded bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 disabled:opacity-30 disabled:pointer-events-none transition"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </div>

        {/* Right: Remote Filesystem */}
        <div className="flex-1 flex flex-col">
          {/* Remote Path Input & Breadcrumbs */}
          <div className="p-2 bg-plinky-900/60 border-b border-plinky-800 space-y-1.5">
            <div className="flex items-center space-x-1.5">
              <Server className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
              <span className="font-medium text-slate-300">Remote:</span>
              <input
                type="text"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                className="flex-1 bg-plinky-950 border border-plinky-700/60 rounded px-2 py-0.5 text-xs text-slate-300 font-mono"
              />
            </div>
            <div className="flex items-center justify-between">
              {renderBreadcrumbs(remotePath, setRemotePath)}
              <div className="flex items-center space-x-1.5">
                <button
                  onClick={handleCreateRemoteFolder}
                  className="p-1 rounded bg-plinky-800 hover:bg-plinky-700 text-slate-300 hover:text-white transition"
                  title="New Remote Folder (mkdir)"
                >
                  <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
                </button>
                <button
                  onClick={handleDeleteRemoteItem}
                  disabled={!selectedRemote || selectedRemote === '..'}
                  className="p-1 rounded bg-plinky-800 hover:bg-red-500/20 text-slate-300 hover:text-red-400 disabled:opacity-30 disabled:pointer-events-none transition"
                  title="Delete Selected Remote Item (rm)"
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                </button>
                <div className="relative flex items-center w-28">
                  <Search className="w-3 h-3 absolute left-1.5 text-slate-500" />
                  <input
                    type="text"
                    placeholder="Filter..."
                    value={remoteFilter}
                    onChange={(e) => setRemoteFilter(e.target.value)}
                    className="w-full pl-5 pr-1 py-0.5 bg-plinky-950 border border-plinky-700/60 rounded text-[10px] text-slate-300"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
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
                {filteredRemote.map((file) => (
                  <tr
                    key={file.name}
                    onClick={() => setSelectedRemote(file.name)}
                    onDoubleClick={() => handleNavigateRemote(file)}
                    className={`cursor-pointer hover:bg-plinky-800/50 transition ${
                      selectedRemote === file.name ? 'bg-emerald-500/20 text-emerald-200' : ''
                    }`}
                  >
                    <td className="py-1 px-2 flex items-center space-x-1.5">
                      {file.isDir ? (
                        <Folder className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                      ) : (
                        <File className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      )}
                      <span className="truncate">{file.name}</span>
                    </td>
                    <td className="py-1 px-2 text-slate-400 font-mono text-[11px]">
                      {file.isDir ? '-' : formatSize(file.size)}
                    </td>
                    <td className="py-1 px-2 text-slate-500 font-mono text-[10px]">
                      {file.permissions}
                    </td>
                    <td className="py-1 px-2 text-slate-500 text-[11px] truncate">
                      {file.modified}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Bottom Transfer Queue Drawer */}
      <div className="h-28 bg-plinky-900 border-t border-plinky-800 flex flex-col">
        <div className="px-3 py-1 bg-plinky-950/60 border-b border-plinky-800 flex items-center justify-between text-[11px] text-slate-400">
          <span className="font-semibold text-slate-300">Transfer Queue ({transfers.length})</span>
          <span className="text-[10px]">Background Transfer Engine Active</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {transfers.map((item) => {
            const pct = Math.round((item.transferred / item.size) * 100);
            return (
              <div key={item.id} className="flex items-center space-x-2 text-xs bg-plinky-950 p-1.5 rounded border border-plinky-800/60">
                {item.direction === 'upload' ? (
                  <Upload className="w-3.5 h-3.5 text-sky-400" />
                ) : (
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                )}
                <span className="font-medium text-slate-200 truncate w-32">{item.filename}</span>
                <div className="flex-1 bg-plinky-800 rounded-full h-1.5 overflow-hidden">
                  <div 
                    className={`h-full ${item.status === 'completed' ? 'bg-emerald-400' : 'bg-sky-400 animate-pulse'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="font-mono text-[11px] text-slate-400 w-12 text-right">{pct}%</span>
                {item.status === 'completed' ? (
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Clock className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
