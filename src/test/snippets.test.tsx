import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { snippetParams, fillSnippet, loadSnippets, saveSnippets, DEFAULT_SNIPPETS } from '../services/snippets';
import { QuickSnippetBar } from '../components/snippets/QuickSnippetBar';

describe('snippet parameters', () => {
  it('lists each parameter once, in order, with its default', () => {
    expect(snippetParams('show int ${IF:Gi0/1} | inc ${WORD}\nshow run int ${IF}\n')).toEqual([
      { name: 'IF', defaultValue: 'Gi0/1' },
      { name: 'WORD', defaultValue: '' },
    ]);
    expect(snippetParams('uptime\n')).toEqual([]);
  });

  it('fills every use of a parameter', () => {
    expect(fillSnippet('ping ${HOST} source ${SRC:Lo0}; traceroute ${HOST}\n', { HOST: '192.0.2.7', SRC: 'Lo1' }))
      .toBe('ping 192.0.2.7 source Lo1; traceroute 192.0.2.7\n');
  });

  it('leaves shell syntax alone: $${VAR}, $$, and Go templates', () => {
    const cmd = 'echo $${HOME} $$ ${USER_ARG}; docker ps --format "{{.ID}}"';
    expect(snippetParams(cmd)).toEqual([{ name: 'USER_ARG', defaultValue: '' }]);
    expect(fillSnippet(cmd, { USER_ARG: 'x' })).toBe('echo ${HOME} $$ x; docker ps --format "{{.ID}}"');
  });

  it('a value the user cleared stays empty rather than falling back to the default', () => {
    expect(fillSnippet('show ${A:default}', { A: '' })).toBe('show ');
  });
});

describe('snippet storage', () => {
  beforeEach(() => localStorage.clear());

  it('starts from the defaults and keeps what is saved', () => {
    expect(loadSnippets()).toEqual(DEFAULT_SNIPPETS);
    saveSnippets([{ id: 'x', name: 'Mine', command: 'w\n', category: 'Custom' }]);
    expect(loadSnippets()).toEqual([{ id: 'x', name: 'Mine', command: 'w\n', category: 'Custom' }]);
    saveSnippets([]);
    expect(loadSnippets()).toEqual([]); // deleting them all sticks
  });

  it('drops malformed entries and survives garbage', () => {
    localStorage.setItem('plinky_snippets', '{nope');
    expect(loadSnippets()).toEqual(DEFAULT_SNIPPETS);
    localStorage.setItem('plinky_snippets', JSON.stringify([
      { id: '1', name: 'ok', command: 'w\n', category: 'System' },
      { id: '2', name: 'bad category', command: 'w\n', category: 'Nope' },
      { id: 3, name: 'bad id', command: 'w\n', category: 'System' },
      null,
    ]));
    expect(loadSnippets().map(s => s.name)).toEqual(['ok']);
  });
});

describe('the snippet bar', () => {
  beforeEach(() => localStorage.clear());

  const open = () => fireEvent.click(screen.getByText('Quick Snippets'));

  it('runs a snippet without parameters straight away', () => {
    const run = vi.fn();
    render(<QuickSnippetBar onExecuteSnippet={run} />);
    fireEvent.click(screen.getAllByText('Disk Usage')[0]);
    expect(run).toHaveBeenCalledWith('df -h\n');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for parameters first, shows the result, and sends it', () => {
    const run = vi.fn();
    render(<QuickSnippetBar onExecuteSnippet={run} activeSessionName="core-sw1" />);
    open();
    fireEvent.click(screen.getByText('Show Interface'));
    expect(run).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Run Show Interface' });
    const input = dialog.querySelector('input')!;
    expect(input.value).toBe('GigabitEthernet0/1'); // the default
    fireEvent.change(input, { target: { value: 'Te1/0/48' } });
    expect(screen.getByTestId('snippet-preview').textContent).toBe('show interfaces Te1/0/48');
    expect(dialog.textContent).toContain('Sends to core-sw1');
    fireEvent.submit(dialog);
    expect(run).toHaveBeenCalledWith('show interfaces Te1/0/48\n');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('will not send with a parameter left empty, and Cancel sends nothing', () => {
    const run = vi.fn();
    render(<QuickSnippetBar onExecuteSnippet={run} />);
    open();
    fireEvent.click(screen.getByText('Ping Host'));
    const dialog = screen.getByRole('dialog');
    expect((screen.getByText('Run').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(dialog);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps added and deleted snippets after a restart', () => {
    const { unmount } = render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    fireEvent.click(screen.getByText('Add Snippet'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Restart Nginx'), { target: { value: 'VLAN brief' } });
    fireEvent.change(screen.getByPlaceholderText(/systemctl restart/), { target: { value: 'show vlan brief' } });
    fireEvent.click(screen.getByText('Save Snippet'));
    open();
    fireEvent.click(screen.getAllByTitle('Delete Snippet')[0]); // Docker PS
    unmount();

    render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    open();
    expect(screen.getByText('VLAN brief')).toBeTruthy();
    expect(screen.queryByText('Docker PS')).toBeNull();
  });

  it('does not write the defaults to storage just by being shown', () => {
    render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    expect(localStorage.getItem('plinky_snippets')).toBeNull();
  });
});
