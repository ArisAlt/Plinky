import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TitleBar } from '../components/layout/TitleBar';
import { PuttySession } from '../types/session';

describe('TitleBar Component - Quick Connect History & Auto-Complete', () => {
  const mockSessions: PuttySession[] = [
    {
      name: 'Server 23',
      protocol: 'SSH',
      hostname: '10.10.10.10',
      port: 22,
      username: 'citizenzero',
    },
    {
      name: 'Bastion Jump',
      protocol: 'SSH',
      hostname: '192.168.1.50',
      port: 2222,
    },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  it('renders brand and navigation tabs', () => {
    render(
      <TitleBar
        onQuickConnect={vi.fn()}
        onNewSession={vi.fn()}
        activeView="sessions"
        setActiveView={vi.fn()}
        sessions={mockSessions}
      />
    );

    expect(screen.getByText('PLINKY')).toBeDefined();
    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('SFTP Pane')).toBeDefined();
    expect(screen.getByText('SSH Tunnels')).toBeDefined();
    expect(screen.getByText('Host Keys')).toBeDefined();
    expect(screen.getByText('Vault')).toBeDefined();
  });

  it('submits quick connect and saves entry to localStorage history', () => {
    const onQuickConnect = vi.fn();

    render(
      <TitleBar
        onQuickConnect={onQuickConnect}
        onNewSession={vi.fn()}
        activeView="sessions"
        setActiveView={vi.fn()}
        sessions={mockSessions}
      />
    );

    const input = screen.getByPlaceholderText('Quick Connect: user@host[:port]...');
    fireEvent.change(input, { target: { value: 'admin@192.168.1.1:2222' } });
    fireEvent.submit(input.closest('form')!);

    expect(onQuickConnect).toHaveBeenCalledWith('192.168.1.1', 2222, 'admin');

    const history = JSON.parse(localStorage.getItem('plinky_quick_connect_history') || '[]');
    expect(history).toContain('admin@192.168.1.1:2222');
  });

  it('shows autocomplete suggestions matching saved sessions and history', () => {
    localStorage.setItem('plinky_quick_connect_history', JSON.stringify(['root@10.0.0.1:22']));
    const onQuickConnect = vi.fn();

    render(
      <TitleBar
        onQuickConnect={onQuickConnect}
        onNewSession={vi.fn()}
        activeView="sessions"
        setActiveView={vi.fn()}
        sessions={mockSessions}
      />
    );

    const input = screen.getByPlaceholderText('Quick Connect: user@host[:port]...');
    fireEvent.focus(input);

    // Initial dropdown with history and saved sessions
    expect(screen.getByText('root@10.0.0.1:22')).toBeDefined();
    expect(screen.getByText('Server 23')).toBeDefined();

    // Type filter for "Bastion"
    fireEvent.change(input, { target: { value: 'Bastion' } });
    expect(screen.getByText('Bastion Jump')).toBeDefined();
    expect(screen.queryByText('Server 23')).toBeNull();

    // Clicking suggestion connects immediately
    fireEvent.click(screen.getByText('Bastion Jump'));
    expect(onQuickConnect).toHaveBeenCalledWith('192.168.1.50', 2222, undefined);
  });

  it('removes item from history and clears all history', () => {
    localStorage.setItem('plinky_quick_connect_history', JSON.stringify(['old-target:22', 'another-target:22']));

    render(
      <TitleBar
        onQuickConnect={vi.fn()}
        onNewSession={vi.fn()}
        activeView="sessions"
        setActiveView={vi.fn()}
        sessions={mockSessions}
      />
    );

    const input = screen.getByPlaceholderText('Quick Connect: user@host[:port]...');
    fireEvent.focus(input);

    expect(screen.getByText('old-target:22')).toBeDefined();
    const removeBtn = screen.getByLabelText('Remove old-target:22 from history');
    fireEvent.click(removeBtn);

    expect(screen.queryByText('old-target:22')).toBeNull();
    expect(screen.getByText('another-target:22')).toBeDefined();

    // Click "Clear All"
    const clearAllBtn = screen.getByText('Clear All');
    fireEvent.click(clearAllBtn);
    expect(screen.queryByText('another-target:22')).toBeNull();
  });
});
