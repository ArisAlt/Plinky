import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SessionExplorer } from '../components/sidebar/SessionExplorer';
import { PuttySession, TerminalTab } from '../types/session';

describe('SessionExplorer Component', () => {
  const mockSessions: PuttySession[] = [
    {
      name: 'Default Settings',
      protocol: 'SSH',
      hostname: 'localhost',
      port: 22,
    },
    {
      name: 'Prod-WebServer',
      protocol: 'SSH',
      hostname: '192.168.1.100',
      port: 2222,
      folder: 'Production',
      tags: ['web', 'frontend'],
    },
  ];

  const mockTabs: TerminalTab[] = [
    {
      id: 'tab-1',
      title: 'Default Settings',
      sessionName: 'Default Settings',
      syncChannel: 'none',
      status: 'live',
      freeTypeMode: false,
      activeHighlighting: true,
      hostname: 'localhost',
      port: 22,
    },
  ];

  it('renders sessions and folders accurately', () => {
    render(
      <SessionExplorer
        sessions={mockSessions}
        tabs={mockTabs}
        activeTabId="tab-1"
        onConnectSession={vi.fn()}
        onOpenSftp={vi.fn()}
        onCreateSession={vi.fn()}
        onEditSession={vi.fn()}
        onMoveToFolder={vi.fn()}
      />
    );

    expect(screen.getByText('Default Settings')).toBeDefined();
    expect(screen.getByText('Prod-WebServer')).toBeDefined();
    expect(screen.getByText('Production')).toBeDefined();
  });

  it('filters sessions using the search box', () => {
    render(
      <SessionExplorer
        sessions={mockSessions}
        tabs={mockTabs}
        activeTabId="tab-1"
        onConnectSession={vi.fn()}
        onOpenSftp={vi.fn()}
        onCreateSession={vi.fn()}
        onEditSession={vi.fn()}
        onMoveToFolder={vi.fn()}
      />
    );

    const searchInput = screen.getByLabelText('Search sessions');
    fireEvent.change(searchInput, { target: { value: 'Prod' } });

    expect(screen.getByText('Prod-WebServer')).toBeDefined();
    expect(screen.queryByText('Default Settings')).toBeNull();
  });

  it('connects via double click and right-click context menu, with no direct Connect button in cards', () => {
    const onConnect = vi.fn();

    render(
      <SessionExplorer
        sessions={mockSessions}
        tabs={[]}
        activeTabId={null}
        onConnectSession={onConnect}
        onOpenSftp={vi.fn()}
        onCreateSession={vi.fn()}
        onEditSession={vi.fn()}
        onMoveToFolder={vi.fn()}
      />
    );

    // 1. Verify NO direct "Connect" button exists in the session tree cards
    const connectButtons = screen.queryAllByRole('button', { name: /^connect$/i });
    expect(connectButtons.length).toBe(0);

    // 2. Single click on a session card does NOT trigger connect (prevents accidental connects)
    const firstSessionText = screen.getByText('Default Settings');
    const firstCard = firstSessionText.closest('[data-session-row]');
    expect(firstCard).not.toBeNull();
    if (firstCard) {
      fireEvent.click(firstCard);
      expect(onConnect).not.toHaveBeenCalled();
    }

    // 3. Double click on a session card connects it (forceNew = true)
    const secondSessionText = screen.getByText('Prod-WebServer');
    const secondCard = secondSessionText.closest('[data-session-row]');
    expect(secondCard).not.toBeNull();
    if (secondCard) {
      fireEvent.doubleClick(secondCard);
      expect(onConnect).toHaveBeenCalledWith(mockSessions[1], true);
    }

    // 4. Right-click opens context menu with "Connect Terminal"
    if (firstCard) {
      fireEvent.contextMenu(firstCard, { clientX: 100, clientY: 100 });
      const menuConnectBtn = screen.getByText('Connect Terminal');
      expect(menuConnectBtn).not.toBeNull();
      fireEvent.click(menuConnectBtn);
      expect(onConnect).toHaveBeenCalledWith(mockSessions[0], true);
    }
  });

  // Design review: one dense row. Compact view cut
  // names to "we..." (web-prod-1 and web-prod-2 looked the same); the card
  // view fit 6 of 12 sessions. The row keeps the name whole, puts the host
  // under it, and shows a protocol chip only when it isn't SSH.
  it('shows each session as one line, SecureCRT style: icon and name, where it goes in the tooltip', () => {
    const onConnect = vi.fn();
    const serial: PuttySession = {
      name: 'console-sw-lab', protocol: 'Serial', hostname: '', port: 0,
      extra: { SerialLine: '/dev/ttyUSB0', SerialSpeed: '9600' },
    };
    render(
      <SessionExplorer
        sessions={[...mockSessions, serial,
          { name: 'gns3-r1', protocol: 'Telnet', hostname: '192.0.2.5', port: 5000 },
          { name: 'ser2net-sw', protocol: 'RAW', hostname: '192.0.2.6', port: 2001 }]}
        tabs={[]}
        activeTabId={null}
        onConnectSession={onConnect}
        onOpenSftp={vi.fn()}
        onCreateSession={vi.fn()}
        onEditSession={vi.fn()}
        onMoveToFolder={vi.fn()}
      />
    );

    // Owner: a compact tree like SecureCRT's. The name is the row; host,
    // port and tags are in its tooltip (default port hidden, a non-default
    // one shown, tags after the host).
    const rowOf = (name: string) => screen.getByText(name).closest('[data-session-row]') as HTMLElement;
    expect(rowOf('Default Settings').title).toBe('SSH · localhost');
    expect(rowOf('Prod-WebServer').title).toMatch(/^SSH · 192\.168\.1\.100:2222 · .*web, frontend/);
    // A serial session says which line and speed, and has the plug icon.
    expect(rowOf('console-sw-lab').title).toBe('Serial · /dev/ttyUSB0 @ 9600');
    expect(rowOf('console-sw-lab').querySelector('.lucide-cable')).not.toBeNull();
    // Each protocol its own icon (owner): SSH a shield.
    expect(rowOf('Default Settings').querySelector('.lucide-shield-check')).not.toBeNull();
    expect(rowOf('gns3-r1').querySelector('.lucide-monitor')).not.toBeNull();
    expect(rowOf('gns3-r1').title).toBe('Telnet · 192.0.2.5:5000');
    expect(rowOf('ser2net-sw').querySelector('.lucide-network')).not.toBeNull();
    // No second line and no protocol chips any more.
    expect(screen.queryByText('localhost')).toBeNull();
    expect(screen.queryAllByText('SSH')).toHaveLength(0);
    expect(screen.queryAllByText('COM')).toHaveLength(0);
    // There is no density toggle any more.
    expect(screen.queryByLabelText('Toggle view density')).toBeNull();

    const row = screen.getByText('Prod-WebServer').closest('[data-session-row]') as HTMLElement;
    fireEvent.doubleClick(row);
    expect(onConnect).toHaveBeenCalledWith(mockSessions[1], true);
  });
});

