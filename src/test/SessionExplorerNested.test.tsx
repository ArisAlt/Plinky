import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SessionExplorer } from '../components/sidebar/SessionExplorer';
import { PuttySession } from '../types/session';
import { getUserFolders } from '../services/sessionMetadata';

// Text as toHaveTextContent compares it (whitespace collapsed). The
// jest-dom matchers aren't in tsc's types here, and `npm run build` runs tsc.
const textOf = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const setSessionFolders = vi.fn();
vi.mock('../services/tauriBridge', () => ({
  setSessionFolders: (...args: unknown[]) => setSessionFolders(...args),
}));

const s = (name: string, folder?: string): PuttySession => ({
  name,
  protocol: 'SSH',
  hostname: `${name}.example`,
  port: 22,
  folder,
});

const sessions = [
  s('db-prod', 'Corp 1/Site 1/Site 1 Production'),
  s('web-prod', 'Corp 1/Site 1/Site 1 Production'),
  s('site1-jump', 'Corp 1/Site 1'),
  s('laptop', 'Home'),
];

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: '' });

function renderExplorer(overrides: Partial<React.ComponentProps<typeof SessionExplorer>> = {}) {
  const props = {
    sessions,
    tabs: [],
    activeTabId: null,
    onConnectSession: vi.fn(),
    onOpenSftp: vi.fn(),
    onCreateSession: vi.fn(),
    onEditSession: vi.fn(),
    onMoveToFolder: vi.fn(),
    onFoldersChanged: vi.fn(),
    ...overrides,
  };
  render(<SessionExplorer {...props} />);
  return props;
}

const folderHeader = (path: string) => {
  const el = document.querySelector(`[data-folder-path="${path}"]`);
  if (!el) throw new Error(`no folder header for ${path}`);
  return el as HTMLElement;
};

describe('SessionExplorer nested folders', () => {
  beforeEach(() => {
    localStorage.clear();
    setSessionFolders.mockReset();
    setSessionFolders.mockResolvedValue(undefined);
  });

  it('shows Corp 1 -> Site 1 -> Site 1 Production as nested levels with recursive counts', () => {
    renderExplorer();
    expect(textOf(folderHeader('Corp 1'))).toContain('(3)');
    expect(textOf(folderHeader('Corp 1/Site 1'))).toContain('(3)');
    expect(textOf(folderHeader('Corp 1/Site 1/Site 1 Production'))).toContain('Site 1 Production(2)');
    expect(screen.getByText('db-prod')).toBeTruthy();
  });

  it('remembers a collapsed folder by its full path', () => {
    renderExplorer();
    fireEvent.click(folderHeader('Corp 1/Site 1'));
    expect(screen.queryByText('db-prod')).toBeNull();
    expect(JSON.parse(localStorage.getItem('plinky_collapsed_folders_v1')!)).toEqual({ 'Corp 1/Site 1': true });
  });

  it('Connect All shows how many sessions it will open and opens nothing until confirmed', () => {
    const props = renderExplorer();
    fireEvent.contextMenu(folderHeader('Corp 1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('Connect All (3)...'));

    const dialog = screen.getByRole('dialog', { name: 'Connect all sessions' });
    expect(textOf(dialog)).toContain('Open 3 sessions?');
    fireEvent.click(screen.getByText('Cancel'));
    expect(props.onConnectSession).not.toHaveBeenCalled();

    fireEvent.contextMenu(folderHeader('Corp 1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('Connect All (3)...'));
    fireEvent.click(screen.getByText('Open 3'));
    expect(props.onConnectSession).toHaveBeenCalledTimes(3);
    expect(props.onConnectSession).toHaveBeenCalledWith(sessions[0], true);
  });

  it('New Session Here opens the editor for that folder, full path and all', () => {
    const props = renderExplorer();
    fireEvent.contextMenu(folderHeader('Corp 1/Site 1/Site 1 Production'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('New Session Here...'));
    expect(props.onCreateSession).toHaveBeenCalledWith('Corp 1/Site 1/Site 1 Production');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the toolbar New button asks for a session with no folder, not a click event', () => {
    // It was wired as onClick={onCreateSession}: once the callback took a
    // folder, the click event would have arrived as the "folder".
    const props = renderExplorer();
    fireEvent.click(screen.getByTitle('Create New PuTTY Session'));
    expect(props.onCreateSession).toHaveBeenCalledWith();
  });

  it('refuses a subfolder name containing "/" and creates nothing', () => {
    renderExplorer();
    fireEvent.contextMenu(folderHeader('Home'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('New Subfolder...'));
    const input = screen.getByLabelText('New subfolder name');
    fireEvent.change(input, { target: { value: 'Lab/Rack 1' } });
    expect(textOf(screen.getByRole('alert'))).toContain('cannot contain "/"');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(getUserFolders()).not.toContain('Home/Lab/Rack 1');
    expect(getUserFolders()).not.toContain('Home/Lab');

    fireEvent.change(input, { target: { value: 'Lab' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(getUserFolders()).toContain('Home/Lab');
  });

  it('renaming a parent rewrites every session below it in one save, then reloads', async () => {
    const props = renderExplorer();
    fireEvent.contextMenu(folderHeader('Corp 1/Site 1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('Rename Folder...'));
    const input = screen.getByLabelText('Rename folder');
    fireEvent.change(input, { target: { value: 'Site A' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(props.onFoldersChanged).toHaveBeenCalled());
    expect(setSessionFolders).toHaveBeenCalledTimes(1);
    expect(setSessionFolders).toHaveBeenCalledWith([
      ['db-prod', 'Corp 1/Site A/Site 1 Production'],
      ['web-prod', 'Corp 1/Site A/Site 1 Production'],
      ['site1-jump', 'Corp 1/Site A'],
    ]);
    expect(getUserFolders()).toContain('Corp 1/Site A');
  });

  it('a rename the backend rejects leaves the folder list alone and says nothing moved', async () => {
    setSessionFolders.mockRejectedValue(new Error('disk full'));
    const props = renderExplorer();
    const before = getUserFolders();
    fireEvent.contextMenu(folderHeader('Corp 1/Site 1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('Rename Folder...'));
    const input = screen.getByLabelText('Rename folder');
    fireEvent.change(input, { target: { value: 'Site A' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText(/Nothing was moved: disk full/)).toBeTruthy();
    expect(getUserFolders()).toEqual(before);
    expect(props.onFoldersChanged).not.toHaveBeenCalled();
  });

  it('refuses to rename a folder onto a sibling that already exists', () => {
    renderExplorer({ sessions: [...sessions, s('site2-jump', 'Corp 1/Site 2')] });
    fireEvent.contextMenu(folderHeader('Corp 1/Site 1'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('Rename Folder...'));
    const input = screen.getByLabelText('Rename folder');
    fireEvent.change(input, { target: { value: 'Site 2' } });
    expect(textOf(screen.getByRole('alert'))).toContain('already exists');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(setSessionFolders).not.toHaveBeenCalled();
  });

  it('will not drop a folder into itself or one of its own subfolders', () => {
    renderExplorer();
    fireEvent.dragStart(folderHeader('Corp 1'), { dataTransfer: dataTransfer() });
    for (const target of ['Corp 1', 'Corp 1/Site 1/Site 1 Production']) {
      const over = fireEvent.dragOver(folderHeader(target), { dataTransfer: dataTransfer() });
      // dragover not cancelled == the browser refuses the drop
      expect(over).toBe(true);
      fireEvent.drop(folderHeader(target), { dataTransfer: dataTransfer() });
    }
    expect(setSessionFolders).not.toHaveBeenCalled();
  });

  it('drops a folder into another folder, carrying its subfolders', async () => {
    const props = renderExplorer();
    fireEvent.dragStart(folderHeader('Corp 1/Site 1'), { dataTransfer: dataTransfer() });
    expect(fireEvent.dragOver(folderHeader('Home'), { dataTransfer: dataTransfer() })).toBe(false);
    fireEvent.drop(folderHeader('Home'), { dataTransfer: dataTransfer() });

    await waitFor(() => expect(props.onFoldersChanged).toHaveBeenCalled());
    expect(setSessionFolders).toHaveBeenCalledWith([
      ['db-prod', 'Home/Site 1/Site 1 Production'],
      ['web-prod', 'Home/Site 1/Site 1 Production'],
      ['site1-jump', 'Home/Site 1'],
    ]);
  });
});
