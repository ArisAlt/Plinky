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

    const searchInput = screen.getByPlaceholderText('Search sessions or tags...');
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
    const firstCard = firstSessionText.closest('div[class*="group flex flex-col"]');
    expect(firstCard).not.toBeNull();
    if (firstCard) {
      fireEvent.click(firstCard);
      expect(onConnect).not.toHaveBeenCalled();
    }

    // 3. Double click on a session card connects it (forceNew = true)
    const secondSessionText = screen.getByText('Prod-WebServer');
    const secondCard = secondSessionText.closest('div[class*="group flex flex-col"]');
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
});
