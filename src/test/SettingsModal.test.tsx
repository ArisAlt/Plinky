import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SettingsModal } from '../components/modals/SettingsModal';
import { vaultDestroy, vaultIsInitialized } from '../services/tauriBridge';

// Mock tauriBridge detectPutty
vi.mock('../services/tauriBridge', () => ({
  detectPutty: vi.fn().mockResolvedValue({
    found: true,
    path: '/usr/bin/plink',
    version: '0.85',
  }),
  vaultIsInitialized: vi.fn().mockResolvedValue(true),
  vaultDestroy: vi.fn().mockResolvedValue(true),
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

    expect(screen.getByText('Plinky Settings')).toBeDefined();

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
});
