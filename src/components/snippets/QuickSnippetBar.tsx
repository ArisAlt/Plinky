import React, { useState } from 'react';
import { SnippetItem } from '../../types/session';
import { 
  Play, 
  Plus, 
  ChevronUp, 
  ChevronDown, 
  Sparkles, 
  X
} from 'lucide-react';

interface QuickSnippetBarProps {
  onExecuteSnippet: (command: string) => void;
  activeSessionName?: string;
}

const DEFAULT_SNIPPETS: SnippetItem[] = [
  { id: '1', name: 'Docker PS', command: 'docker ps --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"\n', category: 'Docker' },
  { id: '2', name: 'Docker Stats', command: 'docker stats --no-stream\n', category: 'Docker' },
  { id: '3', name: 'Disk Usage', command: 'df -h\n', category: 'System' },
  { id: '4', name: 'Memory', command: 'free -h\n', category: 'System' },
  { id: '5', name: 'System Load', command: 'uptime\n', category: 'System' },
  { id: '6', name: 'Open Ports', command: 'ss -tulpn\n', category: 'Network' },
  { id: '7', name: 'Recent Logs', command: 'journalctl -xe --no-pager -n 50\n', category: 'Logs' },
  { id: '8', name: 'Tail Syslog', command: 'tail -f /var/log/syslog\n', category: 'Logs' },
  { id: '9', name: 'Git Status', command: 'git status -sb\n', category: 'Custom' },
];

export const QuickSnippetBar: React.FC<QuickSnippetBarProps> = ({ 
  onExecuteSnippet,
  activeSessionName
}) => {
  const [snippets, setSnippets] = useState<SnippetItem[]>(DEFAULT_SNIPPETS);
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newCategory, setNewCategory] = useState<SnippetItem['category']>('Custom');

  const categories = ['All', 'System', 'Docker', 'Network', 'Logs', 'Custom'];

  const filteredSnippets = selectedCategory === 'All'
    ? snippets
    : snippets.filter(s => s.category === selectedCategory);

  const handleAddSnippet = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newCommand.trim()) return;

    const formattedCommand = newCommand.endsWith('\n') ? newCommand : `${newCommand}\n`;
    const newSnippet: SnippetItem = {
      id: Date.now().toString(),
      name: newName.trim(),
      command: formattedCommand,
      category: newCategory,
    };

    setSnippets(prev => [...prev, newSnippet]);
    setNewName('');
    setNewCommand('');
    setIsAddModalOpen(false);
  };

  const handleDeleteSnippet = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSnippets(prev => prev.filter(s => s.id !== id));
  };

  const getCategoryColor = (cat: SnippetItem['category']) => {
    switch (cat) {
      case 'Docker': return 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30';
      case 'System': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      case 'Network': return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      case 'Logs': return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
      default: return 'text-purple-400 bg-purple-500/10 border-purple-500/30';
    }
  };

  return (
    <div className="bg-plinky-900 border-t border-plinky-800 text-xs select-none">
      {/* Bar Header / Mini Bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-plinky-900/90 text-slate-300">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center space-x-1 font-semibold text-slate-200 hover:text-white transition"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>Quick Snippets</span>
            {isExpanded ? <ChevronDown className="w-3 h-3 text-slate-400" /> : <ChevronUp className="w-3 h-3 text-slate-400" />}
          </button>

          {/* Inline Quick Chips */}
          <div className="flex items-center space-x-1.5 overflow-x-auto max-w-[60vw] py-0.5">
            {snippets.slice(0, 5).map(snippet => (
              <button
                key={snippet.id}
                onClick={() => onExecuteSnippet(snippet.command)}
                title={`Run: ${snippet.command.trim()} on ${activeSessionName || 'active terminal'}`}
                className="group flex items-center space-x-1 px-2 py-0.5 rounded bg-plinky-850 hover:bg-sky-600/30 border border-plinky-750 hover:border-sky-500/40 text-[11px] text-slate-300 hover:text-sky-200 transition font-mono whitespace-nowrap"
              >
                <Play className="w-2.5 h-2.5 text-sky-400 opacity-60 group-hover:opacity-100" />
                <span>{snippet.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setIsAddModalOpen(true)}
            title="Create Custom Snippet"
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-plinky-800 hover:bg-plinky-700 text-slate-300 text-[11px] transition"
          >
            <Plus className="w-3 h-3 text-emerald-400" />
            <span>Add Snippet</span>
          </button>
        </div>
      </div>

      {/* Expanded Category & Snippet Grid Drawer */}
      {isExpanded && (
        <div className="p-3 bg-plinky-950/80 border-t border-plinky-800/80 space-y-2 animate-in slide-in-from-bottom-2 duration-150">
          {/* Category Filter Pills */}
          <div className="flex items-center space-x-1.5 border-b border-plinky-800/60 pb-2">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mr-1">Categories:</span>
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition ${
                  selectedCategory === cat
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-plinky-800/60'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Snippet Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 max-h-36 overflow-y-auto pt-1">
            {filteredSnippets.map(snippet => (
              <div
                key={snippet.id}
                onClick={() => onExecuteSnippet(snippet.command)}
                title={`Execute: ${snippet.command.trim()}`}
                className="group relative flex flex-col p-2 rounded-lg bg-plinky-900 border border-plinky-800 hover:border-sky-500/50 hover:bg-plinky-850 cursor-pointer transition shadow-xs"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`px-1.5 py-0.2 rounded border text-[9px] font-mono font-medium ${getCategoryColor(snippet.category)}`}>
                    {snippet.category}
                  </span>
                  <button
                    onClick={(e) => handleDeleteSnippet(snippet.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-500 hover:text-rose-400 transition"
                    title="Delete Snippet"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <span className="font-semibold text-slate-200 text-xs truncate group-hover:text-sky-300 transition">
                  {snippet.name}
                </span>
                <span className="font-mono text-[10px] text-slate-500 truncate mt-0.5">
                  {snippet.command.trim()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Custom Snippet Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="bg-plinky-900 border border-plinky-700 rounded-xl shadow-2xl max-w-md w-full p-5 text-slate-100">
            <div className="flex items-center justify-between mb-4 border-b border-plinky-800 pb-2">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-semibold">Create Quick Snippet</h3>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAddSnippet} className="space-y-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Snippet Name</label>
                <input
                  type="text"
                  placeholder="e.g. Restart Nginx"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-hidden focus:border-sky-500"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Category</label>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as SnippetItem['category'])}
                  className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-hidden focus:border-sky-500"
                >
                  <option value="System">System</option>
                  <option value="Docker">Docker</option>
                  <option value="Network">Network</option>
                  <option value="Logs">Logs</option>
                  <option value="Custom">Custom</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Command String</label>
                <textarea
                  rows={3}
                  placeholder="e.g. sudo systemctl restart nginx"
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-sky-500"
                  required
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-plinky-800">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-3 py-1.5 rounded bg-plinky-800 hover:bg-plinky-700 text-slate-300 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs shadow-xs"
                >
                  Save Snippet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
