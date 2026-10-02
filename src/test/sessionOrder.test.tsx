import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import { SessionExplorer } from '../components/sidebar/SessionExplorer';
import { PuttySession } from '../types/session';
import { placeName, placeSession, getSessionOrder, rebaseFolderOrder, applyOrder } from '../services/sessionOrder';
import { buildFolderTree } from '../services/folderTree';

vi.mock('../services/tauriBridge', () => ({
  setSessionFolders: vi.fn(),
  deletePuttySession: vi.fn(),
  writePuttySession: vi.fn(),
  readPuttySession: async () => null,
  copyName: (name: string) => `${name} (copy)`,
}));

const s = (name: string, folder?: string): PuttySession => ({
  name, protocol: 'SSH', hostname: '192.0.2.10', port: 22, folder,
});

describe('placing a name', () => {
  it('goes before or after the target, and to the end without one', () => {
    expect(placeName(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b']);
    expect(placeName(['a', 'b', 'c'], 'a', 'b', true)).toEqual(['b', 'a', 'c']);
    expect(placeName(['a', 'b'], 'x', null, false)).toEqual(['a', 'b', 'x']);
    expect(placeName(['a', 'b'], 'a', 'a', false)).toEqual(['b', 'a']);
  });

  it('sessions the order does not name yet follow the ordered ones', () => {
    const items = ['a', 'b', 'new'].map(name => ({ name }));
    expect(applyOrder(items, ['b', 'a']).map(i => i.name)).toEqual(['b', 'a', 'new']);
  });
});

describe('the folder tree with a dragged order', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the dragged order instead of sorting by name', () => {
    const sessions = [s('R1', 'Lab'), s('R2', 'Lab'), s('SW1', 'Lab')];
    placeSession('Lab', ['R1', 'R2', 'SW1'], 'SW1', 'R1', false);
    const lab = buildFolderTree([], sessions, getSessionOrder())[0];
    expect(lab.sessions.map(x => x.name)).toEqual(['SW1', 'R1', 'R2']);
  });

  it('a renamed folder keeps its order, subfolders too', () => {
    placeSession('Lab', ['R1', 'R2'], 'R2', 'R1', false);
    placeSession('Lab/Core', ['C1', 'C2'], 'C2', 'C1', false);
    rebaseFolderOrder('Lab', 'GNS3');
    expect(getSessionOrder()).toEqual({ GNS3: ['R2', 'R1'], 'GNS3/Core': ['C2', 'C1'] });
  });
});

// jsdom has no DragEvent: drag events came out as plain Events, without
// the pointer position the before/after choice reads.
class DragEventWithPointer extends MouseEvent {
  dataTransfer: unknown;
  constructor(type: string, init: MouseEventInit & { dataTransfer?: unknown } = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer;
  }
}
(globalThis as { DragEvent?: unknown }).DragEvent = DragEventWithPointer;

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: '' });
const row = (name: string) => document.querySelector(`[data-session-row="${name}"]`) as HTMLElement;
const shownOrder = () => Array.from(document.querySelectorAll('[data-session-row]')).map(e => e.getAttribute('data-session-row'));

function renderExplorer(sessions: PuttySession[]) {
  const onMoveToFolder = vi.fn();
  const props = {
    sessions, tabs: [], activeTabId: null,
    onConnectSession: vi.fn(), onOpenSftp: vi.fn(), onCreateSession: vi.fn(),
    onEditSession: vi.fn(), onMoveToFolder, onFoldersChanged: vi.fn(),
  };
  render(<SessionExplorer {...props} />);
  return onMoveToFolder;
}

// jsdom has no layout: every row is 0 px tall at y 0, so clientY 0 is its
// top half (before) and clientY 1 its bottom half (after).
function drag(from: string, onto: string, after: boolean) {
  fireEvent.dragStart(row(from), { dataTransfer: dataTransfer() });
  fireEvent.dragOver(row(onto), { clientY: after ? 1 : 0, dataTransfer: dataTransfer() });
  fireEvent.drop(row(onto), { clientY: after ? 1 : 0, dataTransfer: dataTransfer() });
}

describe('dragging saved sessions', () => {
  beforeEach(() => localStorage.clear());

  it('a session dropped on another goes before it, and stays there', () => {
    // Owner: "make saved sessions movable, so I can sort them". They were
    // always sorted by name.
    renderExplorer([s('R1', 'GNS3'), s('R2', 'GNS3'), s('R3', 'GNS3')]);
    drag('R3', 'R1', false);
    expect(shownOrder()).toEqual(['R3', 'R1', 'R2']);
    drag('R3', 'R2', true);
    expect(shownOrder()).toEqual(['R1', 'R2', 'R3']);
    expect(getSessionOrder().GNS3).toEqual(['R1', 'R2', 'R3']);
  });

  it('dropped on a session in another folder, it moves to that folder', () => {
    const onMoveToFolder = renderExplorer([s('R1', 'GNS3'), s('core-sw', 'Lab')]);
    drag('core-sw', 'R1', true);
    expect(onMoveToFolder).toHaveBeenCalledWith(expect.objectContaining({ name: 'core-sw' }), 'GNS3');
    expect(getSessionOrder().GNS3).toEqual(['R1', 'core-sw']);
  });

  it('dropped on "new folder", it moves to the folder it is named', () => {
    const onMoveToFolder = renderExplorer([s('R1', 'GNS3')]);
    fireEvent.dragStart(row('R1'), { dataTransfer: dataTransfer() });
    const zone = document.querySelector('[data-new-folder-drop]') as HTMLElement;
    expect(zone).not.toBeNull();
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer() });
    fireEvent.drop(zone, { dataTransfer: dataTransfer() });
    const input = screen.getByPlaceholderText('New folder for R1, Enter');
    fireEvent.change(input, { target: { value: 'Core' } });
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(onMoveToFolder).toHaveBeenCalledWith(expect.objectContaining({ name: 'R1' }), 'Core');
  });

  it('cancelling the new folder moves nothing', () => {
    const onMoveToFolder = renderExplorer([s('R1', 'GNS3')]);
    fireEvent.dragStart(row('R1'), { dataTransfer: dataTransfer() });
    fireEvent.drop(document.querySelector('[data-new-folder-drop]') as HTMLElement, { dataTransfer: dataTransfer() });
    fireEvent.keyDown(screen.getByPlaceholderText('New folder for R1, Enter'), { key: 'Escape' });
    expect(onMoveToFolder).not.toHaveBeenCalled();
  });
});
