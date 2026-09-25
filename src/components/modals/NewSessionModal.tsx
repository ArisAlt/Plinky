import React, { useState, useEffect } from 'react';
import { PuttySession, Protocol } from '../../types/session';
import { Terminal, X, Save, Key, Folder, Tag } from 'lucide-react';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (session: PuttySession) => void;
  editingSession?: PuttySession | null;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  onClose,
  onSave,
  editingSession,
}) => {
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [port, setPort] = useState('22');
  const [protocol, setProtocol] = useState<Protocol>('SSH');
  const [username, setUsername] = useState('');
  const [folder, setFolder] = useState('Saved Sessions');
  const [tags, setTags] = useState('');
  const [publicKeyFile, setPublicKeyFile] = useState('');

  // Re-seed the form whenever the modal opens -- either blank for a new
  // session, or pre-filled with the session being edited.
  useEffect(() => {
    if (!isOpen) return;
    if (editingSession) {
      setName(editingSession.name);
      setHostname(editingSession.hostname);
      setPort(String(editingSession.port || 22));
      setProtocol(editingSession.protocol);
      setUsername(editingSession.username || '');
      setFolder(editingSession.folder || 'Saved Sessions');
      setTags((editingSession.tags || []).join(', '));
      setPublicKeyFile(editingSession.publicKeyFile || '');
    } else {
      setName('');
      setHostname('');
      setPort('22');
      setProtocol('SSH');
      setUsername('');
      setFolder('Saved Sessions');
      setTags('');
      setPublicKeyFile('');
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

    const parsedPort = parseInt(port, 10) || 22;
    const tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);

    const session: PuttySession = {
      name: name.trim(),
      hostname: hostname.trim(),
      port: parsedPort,
      protocol,
      username: username.trim() || undefined,
      folder: folder.trim() || 'Saved Sessions',
      tags: tagArray.length > 0 ? tagArray : undefined,
      publicKeyFile: publicKeyFile.trim() || undefined,
      extra: editingSession?.extra ? { ...editingSession.extra } : {},
      log_file_name: editingSession?.log_file_name,
      lastConnected: editingSession?.lastConnected,
    };

    onSave(session);
    onClose();
  };

  return (
    <div 
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none"
    >
      <div className="bg-plinky-900 border border-plinky-700 rounded-lg w-[460px] shadow-2xl flex flex-col overflow-hidden text-xs">
        {/* Header */}
        <div className="p-3 bg-plinky-950 border-b border-plinky-800 flex items-center justify-between">
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
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div className="space-y-1">
            <label className="text-slate-300 font-medium">Session Name *</label>
            <input
              type="text"
              required
              placeholder="e.g. Production Web Server"
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

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1">
              <label className="text-slate-300 font-medium">Host Name or IP Address *</label>
              <input
                type="text"
                required
                placeholder="192.0.2.10 or example.com"
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

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">Protocol</label>
              <select
                value={protocol}
                onChange={e => setProtocol(e.target.value as Protocol)}
                className="w-full bg-plinky-950 border border-plinky-700 rounded px-2 py-1.5 text-slate-100 focus:outline-none focus:border-sky-500"
              >
                <option value="SSH">SSH</option>
                <option value="Serial">Serial (COM)</option>
                <option value="Telnet">Telnet</option>
                <option value="Rlogin">Rlogin</option>
                <option value="RAW">RAW</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-slate-300 font-medium">Default Username</label>
              <input
                type="text"
                placeholder="e.g. root or deploy"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-slate-300 font-medium flex items-center space-x-1">
              <Key className="w-3.5 h-3.5 text-amber-400" />
              <span>Private Key File (.ppk)</span>
            </label>
            <input
              type="text"
              placeholder="/path/to/key.ppk (or Pageant will handle auth)"
              value={publicKeyFile}
              onChange={e => setPublicKeyFile(e.target.value)}
              className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 font-mono focus:outline-none focus:border-sky-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium flex items-center space-x-1">
                <Folder className="w-3.5 h-3.5 text-sky-400" />
                <span>Folder Category</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Staging"
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
                placeholder="prod, bastion, web"
                value={tags}
                onChange={e => setTags(e.target.value)}
                className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-2 pt-3 border-t border-plinky-800">
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
