import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VaultManager } from '../components/vault/VaultManager';

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
});
