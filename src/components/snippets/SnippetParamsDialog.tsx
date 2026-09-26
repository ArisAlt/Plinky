import React, { useState } from 'react';
import { Play, X, Braces } from 'lucide-react';
import { SnippetItem } from '../../types/session';
import { SnippetParam, fillSnippet } from '../../services/snippets';

interface SnippetParamsDialogProps {
  snippet: SnippetItem;
  params: SnippetParam[];
  target?: string;
  onRun: (command: string) => void;
  onCancel: () => void;
}

/**
 * Asks for a snippet's ${PARAM} values before it is sent (T-013), showing
 * the command as it will go out. Values are not remembered.
 */
export const SnippetParamsDialog: React.FC<SnippetParamsDialogProps> = ({ snippet, params, target, onRun, onCancel }) => {
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(params.map(p => [p.name, p.defaultValue])),
  );
  const command = fillSnippet(snippet.command, values);
  const missing = params.filter(p => !values[p.name]?.trim()).map(p => p.name);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (missing.length === 0) onRun(command);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
    >
      <form
        role="dialog"
        aria-label={`Run ${snippet.name}`}
        onSubmit={submit}
        className="bg-plinky-900 border border-plinky-700 rounded-xl shadow-2xl max-w-md w-full p-5 text-slate-100 text-xs space-y-3"
      >
        <div className="flex items-center justify-between border-b border-plinky-800 pb-2">
          <div className="flex items-center space-x-2">
            <Braces className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold">{snippet.name}</h3>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="p-1 text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {params.map((p, i) => (
          <label key={p.name} className="block">
            <span className="block text-[11px] text-slate-400 mb-1 font-mono">{p.name}</span>
            <input
              autoFocus={i === 0}
              value={values[p.name] ?? ''}
              onChange={e => setValues(v => ({ ...v, [p.name]: e.target.value }))}
              className="w-full bg-plinky-950 border border-plinky-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-hidden focus:border-sky-500"
            />
          </label>
        ))}

        <div>
          <span className="block text-[11px] text-slate-500 mb-1">Sends{target ? ` to ${target}` : ''}</span>
          <pre data-testid="snippet-preview" className="bg-slate-950 border border-slate-800 rounded p-2 font-mono text-[11px] text-slate-300 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
            {command.replace(/\n$/, '')}
          </pre>
        </div>

        <div className="flex justify-end space-x-2 pt-2 border-t border-plinky-800">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded bg-plinky-800 hover:bg-plinky-700 text-slate-300">
            Cancel
          </button>
          <button
            type="submit"
            disabled={missing.length > 0}
            title={missing.length > 0 ? `Needs a value for ${missing.join(', ')}` : undefined}
            className="flex items-center space-x-1 px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium disabled:opacity-40 disabled:pointer-events-none"
          >
            <Play className="w-3 h-3" />
            <span>Run</span>
          </button>
        </div>
      </form>
    </div>
  );
};
