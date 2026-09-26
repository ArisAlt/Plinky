import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabLauncher } from '../components/layout/TabLauncher';
import { TabTitle } from '../components/layout/TabTitle';
import { getRecentSessions, recordRecentSession, MAX_RECENT } from '../services/recentSessions';
import { PuttySession } from '../types/session';

const session = (name: string, hostname: string, extra: Partial<PuttySession> = {}): PuttySession =>
  ({ name, hostname, port: 22, protocol: 'SSH', ...extra } as PuttySession);

const SESSIONS = [
  session('core-sw1', '10.0.0.1', { folder: 'Lab' }),
  session('edge-rtr', '10.0.0.254'),
  session('bastion', 'jump.example.test', { username: 'ops' }),
];

const launcher = (overrides: Partial<React.ComponentProps<typeof TabLauncher>> = {}) => {
  const props = {
    anchor: { top: 40, left: 100 },
    sessions: SESSIONS,
    recentNames: [] as string[],
    onOpenSession: vi.fn(),
    onOpenLocalShell: vi.fn(),
    onNewSession: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<TabLauncher {...props} />);
  return props;
};

const optionLabels = () => screen.getAllByRole('option').map(o => o.textContent);

describe('the tab launcher', () => {
  it('offers the local shell, every session by name, and a new session', () => {
    launcher();
    expect(optionLabels()).toEqual([
      'Local Shell', 'bastionjump.example.test', 'core-sw110.0.0.1', 'edge-rtr10.0.0.254', 'New Session…',
    ]);
    expect(screen.queryByText('Recent')).toBeNull();
  });

  it('puts recent sessions first, once, and skips recents that were deleted', () => {
    launcher({ recentNames: ['edge-rtr', 'gone-since', 'core-sw1'] });
    expect(optionLabels()).toEqual([
      'Local Shell', 'edge-rtr10.0.0.254', 'core-sw110.0.0.1', 'bastionjump.example.test', 'New Session…',
    ]);
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText('Sessions')).toBeTruthy();
  });

  it('filters on name, host, user and folder', () => {
    launcher();
    const search = screen.getByPlaceholderText('Open a session…');
    fireEvent.change(search, { target: { value: 'ops' } });
    expect(optionLabels()).toEqual(['bastionjump.example.test', 'New Session…']);
    fireEvent.change(search, { target: { value: 'lab' } });
    expect(optionLabels()).toEqual(['core-sw110.0.0.1', 'New Session…']);
    fireEvent.change(search, { target: { value: 'loc' } });
    expect(optionLabels()).toEqual(['Local Shell', 'New Session…']);
  });

  it('opens the highlighted item from the keyboard', () => {
    const props = launcher();
    const search = screen.getByPlaceholderText('Open a session…');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onOpenSession).toHaveBeenCalledWith(SESSIONS[0]);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('Enter on a search opens the first match; Escape just closes', () => {
    const props = launcher();
    const search = screen.getByPlaceholderText('Open a session…');
    fireEvent.change(search, { target: { value: 'edge' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(props.onOpenSession).toHaveBeenCalledWith(SESSIONS[1]);

    const other = launcher();
    fireEvent.keyDown(screen.getAllByPlaceholderText('Open a session…')[1], { key: 'Escape' });
    expect(other.onClose).toHaveBeenCalled();
    expect(other.onOpenSession).not.toHaveBeenCalled();
  });

  it('routes Local Shell and New Session to their own handlers', () => {
    const props = launcher();
    fireEvent.click(screen.getByText('Local Shell'));
    expect(props.onOpenLocalShell).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('New Session…'));
    expect(props.onNewSession).toHaveBeenCalledTimes(1);
    expect(props.onOpenSession).not.toHaveBeenCalled();
  });

  it('closes on a click outside it', () => {
    const props = launcher();
    fireEvent.mouseDown(document.body);
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe('renaming a tab', () => {
  const title = (editing: boolean) => {
    const props = { onStartEdit: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
    render(<TabTitle title="core-sw1" editing={editing} {...props} />);
    return props;
  };

  it('starts on a double-click', () => {
    const props = title(false);
    fireEvent.doubleClick(screen.getByText('core-sw1'));
    expect(props.onStartEdit).toHaveBeenCalled();
  });

  it('keeps the trimmed name on Enter, once', () => {
    const props = title(true);
    const input = screen.getByLabelText('Tab name');
    fireEvent.change(input, { target: { value: '  core switch  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith('core switch');
  });

  it('keeps it on leaving the field too', () => {
    const props = title(true);
    const input = screen.getByLabelText('Tab name');
    fireEvent.change(input, { target: { value: 'uplink' } });
    fireEvent.blur(input);
    expect(props.onCommit).toHaveBeenCalledWith('uplink');
  });

  it('throws the edit away on Escape, and on an empty or unchanged name', () => {
    const esc = title(true);
    const input = screen.getByLabelText('Tab name');
    fireEvent.change(input, { target: { value: 'something' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(esc.onCommit).not.toHaveBeenCalled();
    expect(esc.onCancel).toHaveBeenCalledTimes(1);
  });

  it('an empty name keeps the old one', () => {
    const props = title(true);
    const input = screen.getByLabelText('Tab name');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onCancel).toHaveBeenCalled();
  });
});

describe('recent sessions', () => {
  beforeEach(() => localStorage.clear());

  it('are newest first, without repeats, and capped', () => {
    recordRecentSession('a');
    recordRecentSession('b');
    recordRecentSession('a');
    expect(getRecentSessions()).toEqual(['a', 'b']);
    for (let i = 0; i < MAX_RECENT + 3; i++) recordRecentSession(`s${i}`);
    expect(getRecentSessions()).toHaveLength(MAX_RECENT);
    expect(getRecentSessions()[0]).toBe(`s${MAX_RECENT + 2}`);
  });

  it('survive garbage in storage', () => {
    localStorage.setItem('plinky_recent_sessions', '{not json');
    expect(getRecentSessions()).toEqual([]);
    localStorage.setItem('plinky_recent_sessions', JSON.stringify(['ok', 3, null]));
    expect(getRecentSessions()).toEqual(['ok']);
    recordRecentSession('new');
    expect(getRecentSessions()).toEqual(['new', 'ok']);
  });
});
