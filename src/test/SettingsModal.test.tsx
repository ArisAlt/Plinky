import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SettingsModal } from '../components/modals/SettingsModal';
import { vaultDestroy, vaultIsInitialized, setLoggingSettings } from '../services/tauriBridge';
import { version } from '../../package.json';

// Mock tauriBridge detectPutty
vi.mock('../services/tauriBridge', () => ({
  detectPutty: vi.fn().mockResolvedValue({
    found: true,
    path: '/usr/bin/plink',
    version: '0.85',
  }),
  vaultIsInitialized: vi.fn().mockResolvedValue(true),
  vaultDestroy: vi.fn().mockResolvedValue(true),
  getLoggingSettings: vi.fn().mockResolvedValue({ enabled: false, dir: '/home/ops/Documents/Thyrion Logs', default_dir: true, mode: 'printable' }),
  setLoggingSettings: vi.fn(async (enabled: boolean, dir: string | null, mode: string) => ({
    enabled, mode, dir: dir ?? '/home/ops/Documents/Thyrion Logs', default_dir: dir === null,
  })),
  pickLogFolder: vi.fn().mockResolvedValue('/srv/logs'),
}));

describe('SettingsModal Component', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(
      <SettingsModal
        isOpen={false}
        onClose={vi.fn()}
        fontFamily="monospace"
        onChangeFontFamily={vi.fn()}
        fontSize={13}
        onChangeFontSize={vi.fn()}
        cursorStyle="block"
        onChangeCursorStyle={vi.fn()}
        onResetLayout={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders and calls callbacks when options change', () => {
    const onChangeFont = vi.fn();
    const onChangeSize = vi.fn();
    const onChangeCursor = vi.fn();
    const onReset = vi.fn();

    render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        fontFamily="monospace"
        onChangeFontFamily={onChangeFont}
        fontSize={13}
        onChangeFontSize={onChangeSize}
        cursorStyle="block"
        onChangeCursorStyle={onChangeCursor}
        onResetLayout={onReset}
      />
    );

    expect(screen.getByText('Global Settings')).toBeDefined();

    // Change cursor style to underline
    const underlineBtn = screen.getByRole('button', { name: /underline/i });
    fireEvent.click(underlineBtn);
    expect(onChangeCursor).toHaveBeenCalledWith('underline');

    // Click Reset Layout
    const resetBtn = screen.getByRole('button', { name: /reset layout/i });
    fireEvent.click(resetBtn);
    expect(onReset).toHaveBeenCalled();
  });

  describe('Delete Vault', () => {
    const renderSettings = () => render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        fontFamily="monospace"
        onChangeFontFamily={vi.fn()}
        fontSize={13}
        onChangeFontSize={vi.fn()}
        cursorStyle="block"
        onChangeCursorStyle={vi.fn()}
        onResetLayout={vi.fn()}
      />
    );
    const destroy = vi.mocked(vaultDestroy);
    const openDelete = async () => {
      const btn = await screen.findByRole('button', { name: /^Delete Vault$/ });
      await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(btn);
    };

    it('deletes only after both warnings are accepted', async () => {
      destroy.mockClear();
      renderSettings();
      await openDelete();
      expect(screen.getByRole('alertdialog', { name: 'First warning' })).toBeTruthy();
      expect(destroy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Yes, continue' }));
      expect(screen.getByRole('alertdialog', { name: 'Final warning' })).toBeTruthy();
      expect(destroy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Delete vault permanently' }));
      expect(await screen.findByText('Vault deleted. Open Vault to create a new one.')).toBeTruthy();
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('deletes nothing when either warning is cancelled', async () => {
      destroy.mockClear();
      renderSettings();
      await openDelete();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();

      await openDelete();
      fireEvent.click(screen.getByRole('button', { name: 'Yes, continue' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(destroy).not.toHaveBeenCalled();
    });

    it('offers nothing to delete when there is no vault', async () => {
      vi.mocked(vaultIsInitialized).mockResolvedValueOnce(false);
      renderSettings();
      const btn = await screen.findByRole('button', { name: /^Delete Vault$/ });
      await waitFor(() => expect(vi.mocked(vaultIsInitialized)).toHaveBeenCalled());
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('About names the app, its real version, and Alis', () => {
    // The app showed its version nowhere. Alis, the mascot, was the
    // owner's dog.
    render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        fontFamily="monospace"
        onChangeFontFamily={vi.fn()}
        fontSize={13}
        onChangeFontSize={vi.fn()}
        cursorStyle="block"
        onChangeCursorStyle={vi.fn()}
        onResetLayout={vi.fn()}
      />
    );
    const about = document.querySelector('[data-about]') as HTMLElement;
    expect(about.textContent).toContain('Thyrion');
    expect(about.textContent).toContain(`v${version}`);
    expect(about.textContent).toContain('Alis');
  });

  describe('Logging', () => {
    const renderSettings = () => render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        fontFamily="monospace"
        onChangeFontFamily={vi.fn()}
        fontSize={13}
        onChangeFontSize={vi.fn()}
        cursorStyle="block"
        onChangeCursorStyle={vi.fn()}
        onResetLayout={vi.fn()}
      />
    );

    it('shows the folder logs go to and how they are filed', async () => {
      renderSettings();
      expect(await screen.findByText('/home/ops/Documents/Thyrion Logs')).toBeInTheDocument();
      expect(screen.getByText(/<folder>\/<session>\/2026-10-14_16-05-33\.log/)).toBeInTheDocument();
    });

    it('turns automatic logging on, keeping the default folder and the format', async () => {
      renderSettings();
      fireEvent.click(await screen.findByLabelText('Log every session automatically'));
      await waitFor(() => expect(setLoggingSettings).toHaveBeenCalledWith(true, null, 'printable'));
    });

    it('a chosen folder is saved, and Default puts it back', async () => {
      renderSettings();
      fireEvent.click(await screen.findByText('Choose…'));
      await waitFor(() => expect(setLoggingSettings).toHaveBeenCalledWith(false, '/srv/logs', 'printable'));
      fireEvent.click(await screen.findByText('Default'));
      await waitFor(() => expect(setLoggingSettings).toHaveBeenLastCalledWith(false, null, 'printable'));
    });
  });
});
