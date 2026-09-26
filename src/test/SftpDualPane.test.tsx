import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const bridge = vi.hoisted(() => ({
  sftpRemoteHome: vi.fn(),
  sftpList: vi.fn(),
  sftpMkdir: vi.fn(),
  sftpRemove: vi.fn(),
  sftpUpload: vi.fn(),
  sftpDownload: vi.fn(),
  listLocalFiles: vi.fn(),
  getLocalHomeDir: vi.fn(),
}));

vi.mock('../services/tauriBridge', () => ({
  ...bridge,
  SFTP_ERR_PASSWORD: '[password] ',
  SFTP_ERR_HOSTKEY: '[hostkey] ',
  VAULT_CHANGED_EVENT: 'plinky:vault-changed',
}));

import {
  SftpDualPane, isSafeEntryName, joinLocal, parentLocal, parentRemote,
} from '../components/sftp/SftpDualPane';

const file = (name: string, isDir = false) => ({
  name, isDir, isSymlink: false, size: 12, permissions: '-rw-r--r--', owner: 'u', group: 'u', modified: 'Sep 25 10:00',
});

beforeEach(() => {
  Object.values(bridge).forEach(f => f.mockReset());
  bridge.getLocalHomeDir.mockResolvedValue('/home/me');
  bridge.listLocalFiles.mockResolvedValue([file('notes.txt')]);
  bridge.sftpRemoteHome.mockResolvedValue('/home/remote');
  bridge.sftpList.mockResolvedValue([file('report.pdf')]);
});

describe('SFTP path helpers', () => {
  it('refuses names that would escape the chosen folder', () => {
    for (const bad of ['..', '.', '../../.bashrc', 'a/b', 'a\\b', 'x\0y', '']) {
      expect(isSafeEntryName(bad)).toBe(false);
    }
    expect(isSafeEntryName('we"ird name.txt')).toBe(true);
  });

  it('joins and climbs both POSIX and Windows local paths', () => {
    expect(joinLocal('/home/me', 'a.txt')).toBe('/home/me/a.txt');
    expect(joinLocal('C:\\Users\\me', 'a.txt')).toBe('C:\\Users\\me\\a.txt');
    expect(parentLocal('/home/me')).toBe('/home');
    expect(parentLocal('/home')).toBe('/');
    expect(parentLocal('C:\\Users\\me')).toBe('C:\\Users');
    expect(parentLocal('C:\\Users')).toBe('C:\\');
    expect(parentRemote('/var/www')).toBe('/var');
    expect(parentRemote('/var')).toBe('/');
  });
});

describe('SftpDualPane', () => {
  it('shows the real local folder and the remote home, not demo data', async () => {
    render(<SftpDualPane sessionName="web" hostname="10.0.0.5" />);
    expect(await screen.findByText('notes.txt')).toBeTruthy();
    expect(await screen.findByText('report.pdf')).toBeTruthy();
    expect(bridge.sftpList).toHaveBeenCalledWith(expect.objectContaining({ sessionName: 'web' }), '/home/remote');
  });

  it('marks a failed download as failed, with the reason', async () => {
    // The old pane appended "completed" without transferring anything.
    bridge.sftpDownload.mockRejectedValue('/home/remote/report.pdf: open for read: permission denied');
    render(<SftpDualPane sessionName="web" hostname="10.0.0.5" />);
    fireEvent.doubleClick(await screen.findByText('report.pdf'));
    expect(await screen.findByText(/permission denied/)).toBeTruthy();
    expect(screen.queryByText('Done')).toBeNull();
    expect(bridge.sftpDownload).toHaveBeenCalledWith(expect.anything(), '/home/remote/report.pdf', '/home/me/report.pdf');
  });

  it('refuses to download a file whose name would escape the local folder', async () => {
    bridge.sftpList.mockResolvedValue([file('../../.bashrc')]);
    render(<SftpDualPane sessionName="evil" hostname="10.6.6.6" />);
    fireEvent.doubleClick(await screen.findByText('../../.bashrc'));
    expect(await screen.findByText(/Refusing to download/)).toBeTruthy();
    expect(bridge.sftpDownload).not.toHaveBeenCalled();
  });

  it('asks for a password when the server needs one, and never reuses it on another server', async () => {
    bridge.sftpRemoteHome.mockImplementation(async (t: { password?: string }) => {
      if (!t.password) throw '[password] This server needs a password.';
      return '/home/remote';
    });
    const { rerender } = render(<SftpDualPane sessionName="a" hostname="host-a" />);
    const input = await screen.findByPlaceholderText(/Password for host-a/);
    expect(screen.getByText('This server needs a password.')).toBeTruthy(); // tag stripped

    fireEvent.change(input, { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy());
    expect(bridge.sftpList).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'host-a', password: 's3cret' }), '/home/remote');

    // Same pane, different server: the password typed for host-a must not go along.
    rerender(<SftpDualPane sessionName="b" hostname="host-b" />);
    await screen.findByPlaceholderText(/Password for host-b/);
    const toB = bridge.sftpRemoteHome.mock.calls.map(c => c[0]).filter(t => t.hostname === 'host-b');
    expect(toB.length).toBeGreaterThan(0);
    expect(toB.every(t => !t.password)).toBe(true);
  });

  it('explains an untrusted host key instead of showing a password prompt', async () => {
    bridge.sftpRemoteHome.mockRejectedValue("[hostkey] This server's host key isn't trusted yet. Open the session in a terminal tab once and accept its key, then try again.");
    render(<SftpDualPane sessionName="new" hostname="10.0.0.9" />);
    expect(await screen.findByText(/accept its key/)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Password for/)).toBeNull();
  });

  it('retries by itself once the vault is unlocked', async () => {
    let unlocked = false;
    bridge.sftpRemoteHome.mockImplementation(async () => {
      if (!unlocked) throw "[password] This server needs a password. If it's saved in the vault, unlock the vault and retry.";
      return '/home/remote';
    });
    render(<SftpDualPane sessionName="Server 2" hostname="10.10.10.10" />);
    expect(await screen.findByText(/unlock the vault and retry/)).toBeTruthy();
    unlocked = true;
    window.dispatchEvent(new Event('plinky:vault-changed'));
    expect(await screen.findByText('report.pdf')).toBeTruthy();
  });
});

describe('the transfer queue drawer (T-014)', () => {
  const queue = () => document.getElementById('sftp-transfer-queue');
  const header = () => screen.getByRole('button', { name: /Transfers \(/ });

  it('starts folded, with the hint in its header', async () => {
    render(<SftpDualPane sessionName="web" hostname="10.0.0.5" />);
    await screen.findByText('report.pdf');
    expect(queue()).toBeNull();
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/drag it to the other pane/)).toBeTruthy();
  });

  it('opens when a transfer starts, and folded still counts what finished', async () => {
    bridge.sftpDownload.mockResolvedValue(undefined);
    render(<SftpDualPane sessionName="web" hostname="10.0.0.5" />);
    fireEvent.doubleClick(await screen.findByText('report.pdf'));
    await waitFor(() => expect(queue()).toBeTruthy());
    expect(await screen.findByText('Done')).toBeTruthy();
    fireEvent.click(header());
    expect(queue()).toBeNull();
    expect(screen.getByText('1 done')).toBeTruthy();
    expect(header().textContent).toContain('Transfers (1)');
  });

  it('opens again when a transfer fails, even if it was folded meanwhile', async () => {
    let fail: (reason: string) => void = () => {};
    bridge.sftpDownload.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    render(<SftpDualPane sessionName="web" hostname="10.0.0.5" />);
    fireEvent.doubleClick(await screen.findByText('report.pdf'));
    await waitFor(() => expect(queue()).toBeTruthy());
    fireEvent.click(header()); // fold it while the transfer runs
    expect(screen.getByText('1 running')).toBeTruthy();
    fail('/home/remote/report.pdf: open for read: permission denied');
    expect(await screen.findByText(/permission denied/)).toBeTruthy();
    expect(queue()).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
  });
});
