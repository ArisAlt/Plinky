import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VaultManager } from '../components/vault/VaultManager';
import { vaultExportKdbx } from '../services/tauriBridge';

vi.mock('../services/tauriBridge', () => ({
  vaultIsInitialized: vi.fn().mockResolvedValue(true),
  vaultIsUnlocked: vi.fn().mockResolvedValue(false),
  vaultCreate: vi.fn(),
  vaultUnlock: vi.fn(),
  vaultLock: vi.fn(),
  vaultListEntriesMeta: vi.fn().mockResolvedValue([]),
  vaultGetEntry: vi.fn(),
  vaultSetEntry: vi.fn(),
  vaultDelete: vi.fn(),
  vaultExportKdbx: vi.fn(),
}));

describe('VaultManager Component', () => {
  it('renders and invokes onClose callback on Close button click', () => {
    const handleClose = vi.fn();
    render(<VaultManager onClose={handleClose} />);

    expect(screen.getByText('Plinky Credential Vault')).toBeDefined();

    const closeButton = screen.getByTitle('Close Vault and return to Terminal (Esc)');
    expect(closeButton).toBeDefined();

    fireEvent.click(closeButton);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when Escape key is pressed', () => {
    const handleClose = vi.fn();
    render(<VaultManager onClose={handleClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when Cancel button on unlock card is clicked', async () => {
    const handleClose = vi.fn();
    render(<VaultManager onClose={handleClose} />);

    const cancelButton = await screen.findByRole('button', { name: 'Cancel' });
    expect(cancelButton).toBeDefined();

    fireEvent.click(cancelButton);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when top-right card close button is clicked', async () => {
    const handleClose = vi.fn();
    render(<VaultManager onClose={handleClose} />);

    const cardClose = await screen.findByTitle('Cancel and return to Terminal (Esc)');
    expect(cardClose).toBeDefined();

    fireEvent.click(cardClose);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  describe('Export to KeePass', () => {
    const exportMock = vi.mocked(vaultExportKdbx);
    const openAndSubmit = async (password: string) => {
      render(<VaultManager />);
      fireEvent.click(await screen.findByText('Export to KeePass'));
      fireEvent.change(screen.getByLabelText('Vault master password'), { target: { value: password } });
      fireEvent.click(screen.getByRole('button', { name: /choose file and export/i }));
    };

    it('exports with the master password and reports where the file went', async () => {
      exportMock.mockReset().mockResolvedValue({ path: '/home/me/plinky-vault.kdbx', entries: 3 });
      await openAndSubmit('master-pw');
      expect(await screen.findByText('Exported 3 entries to /home/me/plinky-vault.kdbx')).toBeDefined();
      expect(exportMock).toHaveBeenCalledWith('master-pw');
    });

    it('keeps the dialog open and says why when the password is wrong', async () => {
      exportMock.mockReset().mockRejectedValue("That isn't the vault's master password.");
      await openAndSubmit('nope');
      expect(await screen.findByText("That isn't the vault's master password.")).toBeDefined();
      expect(screen.getByRole('button', { name: /choose file and export/i })).toBeDefined();
      expect((screen.getByLabelText('Vault master password') as HTMLInputElement).value).toBe('');
    });

    it('stays quiet when the save dialog is cancelled', async () => {
      exportMock.mockReset().mockResolvedValue(null);
      await openAndSubmit('master-pw');
      await waitFor(() => expect(exportMock).toHaveBeenCalled());
      expect(screen.queryByText(/Exported/)).toBeNull();
    });
  });
});
