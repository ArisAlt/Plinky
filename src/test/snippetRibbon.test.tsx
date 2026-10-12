import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuickSnippetBar } from '../components/snippets/QuickSnippetBar';
import { loadRibbon, DEFAULT_SNIPPETS } from '../services/snippets';

// jsdom has no DragEvent: drag events lost the pointer position.
class DragEventWithPointer extends MouseEvent {
  dataTransfer: unknown;
  constructor(type: string, init: MouseEventInit & { dataTransfer?: unknown } = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer;
  }
}
(globalThis as { DragEvent?: unknown }).DragEvent = DragEventWithPointer;

const dt = () => ({ setData: vi.fn(), effectAllowed: '' });
const ribbonNames = () =>
  Array.from(document.querySelectorAll('[data-ribbon-snippet]')).map(e => e.textContent?.trim());
const idOf = (name: string) => DEFAULT_SNIPPETS.find(s => s.name === name)!.id;
const chip = (name: string) => document.querySelector(`[data-ribbon-snippet="${idOf(name)}"]`) as HTMLElement;
const item = (name: string) => document.querySelector(`[data-snippet-item="${idOf(name)}"]`) as HTMLElement;
const ribbon = () => document.querySelector('[data-snippet-ribbon]') as HTMLElement;
const open = () => fireEvent.click(screen.getByText('Quick Snippets'));

// jsdom has no layout: clientX 0 is a chip's left half, 1 its right.
function drop(from: HTMLElement, onto: HTMLElement, after = false) {
  fireEvent.dragStart(from, { dataTransfer: dt() });
  fireEvent.dragOver(onto, { clientX: after ? 1 : 0, dataTransfer: dt() });
  fireEvent.drop(onto, { clientX: after ? 1 : 0, dataTransfer: dt() });
  fireEvent.dragEnd(from, { dataTransfer: dt() });
}

describe('the snippet ribbon', () => {
  beforeEach(() => localStorage.clear());

  it('shows the first five until the user picks, as before', () => {
    render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    expect(ribbonNames()).toEqual(['Interfaces', 'No paging', 'Config section', 'Ping', 'Traceroute']);
  });

  it('a pinned snippet goes on the bar and stays there after a restart', () => {
    // Owner: "I want to be able to place them in the ribbon".
    const { unmount } = render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    open();
    fireEvent.click(screen.getByLabelText('Put Version on the bar'));
    expect(ribbonNames().at(-1)).toBe('Version');
    fireEvent.click(screen.getByLabelText('Take Ping off the bar'));
    expect(ribbonNames()).not.toContain('Ping');
    unmount();
    render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    expect(ribbonNames()).toEqual(['Interfaces', 'No paging', 'Config section', 'Traceroute', 'Version']);
  });

  it('a snippet dragged from the list onto a chip lands before or after it', () => {
    render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    open();
    drop(item('Version'), chip('No paging'));
    expect(ribbonNames().slice(0, 3)).toEqual(['Interfaces', 'Version', 'No paging']);
    drop(item('Load'), chip('Traceroute'), true);
    expect(ribbonNames().at(-1)).toBe('Load');
  });

  it('dropped on the empty part of the bar, it goes at the end', () => {
    render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    open();
    drop(item('Journal'), ribbon());
    expect(ribbonNames().at(-1)).toBe('Journal');
  });

  it('chips on the bar can be dragged into a new order', () => {
    render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    drop(chip('Traceroute'), chip('Interfaces'));
    expect(ribbonNames()).toEqual(['Traceroute', 'Interfaces', 'No paging', 'Config section', 'Ping']);
  });

  it('a deleted snippet leaves the bar too', () => {
    render(<QuickSnippetBar onExecuteSnippet={vi.fn()} />);
    open();
    fireEvent.click(screen.getByLabelText('Delete Ping'));
    expect(ribbonNames()).not.toContain('Ping');
    expect(loadRibbon(DEFAULT_SNIPPETS)).not.toContain(idOf('Ping'));
  });

  it('a chip still runs its snippet with a click', () => {
    const run = vi.fn();
    render(<QuickSnippetBar onExecuteSnippet={run} />);
    fireEvent.click(chip('No paging'));
    expect(run).toHaveBeenCalledWith('terminal length 0\n');
  });
});
