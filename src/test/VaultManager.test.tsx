import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VaultManager } from '../components/vault/VaultManager';
import { vaultExportKdbx, vaultIsUnlocked, vaultListEntriesMeta, vaultGetEntry, vaultSetEntry } from '../services/tauriBridge';

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

describe('editing a vault entry', () => {
  const stored = {
    id: 'session:core-sw1', username: 'netops', secret: 'old-pass', enable_secret: 'old-enable',
    notes: 'lab switch', created_at: 100, updated_at: 100,
  };
  const openEdit = async () => {
    vi.mocked(vaultIsUnlocked).mockResolvedValue(true);
    vi.mocked(vaultListEntriesMeta).mockResolvedValue([
      { id: stored.id, username: 'netops', has_enable_secret: true, notes: 'lab switch', created_at: 100, updated_at: 100 },
    ]);
    vi.mocked(vaultGetEntry).mockResolvedValue({ ...stored });
    vi.mocked(vaultSetEntry).mockReset().mockResolvedValue(true);
    render(<VaultManager />);
    fireEvent.click(await screen.findByLabelText(`Edit ${stored.id}`));
  };
  const saved = () => vi.mocked(vaultSetEntry).mock.calls[0][0];

  it('opens the entry in the form, key read-only, secrets not decrypted into it', async () => {
    await openEdit();
    expect(screen.getByText('Edit Credential')).toBeTruthy();
    const key = screen.getByLabelText('Key / Session Identifier') as HTMLInputElement;
    expect(key.value).toBe(stored.id);
    expect(key.readOnly).toBe(true);
    expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe('');
    expect((screen.getByDisplayValue('netops') as HTMLInputElement)).toBeTruthy();
  });

  it('keeps the stored passwords when their fields are left empty', async () => {
    await openEdit();
    fireEvent.change(screen.getByDisplayValue('lab switch'), { target: { value: 'core switch, rack 4' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(vaultSetEntry).toHaveBeenCalledTimes(1));
    expect(saved()).toMatchObject({
      id: stored.id, secret: 'old-pass', enable_secret: 'old-enable',
      notes: 'core switch, rack 4', created_at: 100,
    });
    expect(saved().updated_at).toBeGreaterThan(100);
  });

  it('replaces a password that is typed in', async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'new-pass' } });
    fireEvent.change(screen.getByLabelText('Enable Password'), { target: { value: 'new-enable' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(vaultSetEntry).toHaveBeenCalledTimes(1));
    expect(saved()).toMatchObject({ secret: 'new-pass', enable_secret: 'new-enable' });
  });

  it('removes the enable password when Network Device is unticked', async () => {
    await openEdit();
    fireEvent.click(screen.getByLabelText(/Network Device/));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(vaultSetEntry).toHaveBeenCalledTimes(1));
    expect(saved().enable_secret).toBeUndefined();
    expect(saved().secret).toBe('old-pass');
  });
});

