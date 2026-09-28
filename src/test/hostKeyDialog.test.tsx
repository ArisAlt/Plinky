import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// TerminalView pulls in xterm, which needs a canvas jsdom lacks. The dialog
// does not use it.
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));

vi.mock('../services/tauriBridge', async (orig) => ({
  ...(await orig<typeof import('../services/tauriBridge')>()),
  listPuttyHostKeys: async () => [
    { keyType: 'rsa2', hostname: '127.0.0.1', port: 2230, rawKey: '', fingerprint: 'SHA256:savedRSA' },
    { keyType: 'ssh-ed25519', hostname: '127.0.0.1', port: 2230, rawKey: '', fingerprint: 'SHA256:savedED' },
    { keyType: 'ssh-ed25519', hostname: '127.0.0.1', port: 22, rawKey: '', fingerprint: 'SHA256:otherPort' },
  ],
}));

import { HostKeyDialog, storedFingerprint } from '../components/terminal/TerminalView';

const base = {
  host: '127.0.0.1',
  port: 2230,
  key_type: 'ssh-ed25519',
  fingerprint: 'SHA256:3O68y3/hYcPWT0PvUA6iAW4Hke8MxUWDn1JMiSW6EGo',
  raw_prompt: '',
};

describe('host key dialog', () => {
  it('a changed key says it changed, and Abandon has the focus', () => {
    render(<HostKeyDialog prompt={{ ...base, changed: true }} onAnswer={() => {}} />);
    expect(screen.getByRole('alertdialog').textContent).toMatch(/host key has changed/);
    expect(document.activeElement?.textContent).toBe('Abandon connection');
    expect(screen.queryByText(/not cached/)).toBeNull();
  });

  it('accepting a changed key is worded as replacing it', () => {
    const onAnswer = vi.fn();
    render(<HostKeyDialog prompt={{ ...base, changed: true }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('I expected this: replace the key'));
    expect(onAnswer).toHaveBeenCalledWith('store');
  });

  it('a first visit reads as a new host, not a breach', () => {
    render(<HostKeyDialog prompt={base} onAnswer={() => {}} />);
    expect(screen.getByRole('alertdialog').textContent).toMatch(/New host/);
    expect(screen.getByText('Trust and store key')).toBeTruthy();
  });

  it('Escape abandons, as Return does in plink', () => {
    const onAnswer = vi.fn();
    render(<HostKeyDialog prompt={{ ...base, changed: true }} onAnswer={onAnswer} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAnswer).toHaveBeenCalledWith('reject');
  });

  it('a changed key shows the saved fingerprint beside the offered one', async () => {
    render(<HostKeyDialog prompt={{ ...base, changed: true }} onAnswer={() => {}} />);
    expect(await screen.findByText('SHA256:savedED')).toBeTruthy();
    expect(screen.getByText('Saved by PuTTY earlier')).toBeTruthy();
  });

  it('matches the saved key by host, port and PuTTY\'s name for the type', async () => {
    // The prompt says "ssh-rsa"; PuTTY's cache says "rsa2".
    expect(await storedFingerprint({ ...base, key_type: 'ssh-rsa' })).toBe('SHA256:savedRSA');
    expect(await storedFingerprint({ ...base, port: 2231 })).toBeNull();
  });
});


describe('the weak-crypto question', () => {
  const weak = { ...base, host: '', port: 0, key_type: '', fingerprint: '', weak: 'key-exchange algorithm: diffie-hellman-group1-sha1' };

  it('names the outdated algorithm and asks, instead of landing in the terminal', () => {
    // An old Cisco router's plink question used to arrive as terminal text
    // the user had to answer by typing "y".
    const onAnswer = vi.fn();
    render(<HostKeyDialog prompt={weak} onAnswer={onAnswer} />);
    expect(screen.getByText(/only offers outdated encryption/)).toBeTruthy();
    expect(screen.getByText('diffie-hellman-group1-sha1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect anyway' }));
    expect(onAnswer).toHaveBeenCalledWith('once');
  });

  it('Escape and Abandon both abandon', () => {
    const onAnswer = vi.fn();
    render(<HostKeyDialog prompt={weak} onAnswer={onAnswer} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Abandon connection' }));
    expect(onAnswer.mock.calls).toEqual([['reject'], ['reject']]);
  });
});

describe('a question Plinky has no dialog for', () => {
  it('shows plink\'s text and answers yes or no', () => {
    const onAnswer = vi.fn();
    const q = { ...base, host: '', port: 0, key_type: '', fingerprint: '', question: 'Something new.\nAllow it? (y/n)' };
    render(<HostKeyDialog prompt={q} onAnswer={onAnswer} />);
    expect(screen.getByText(/Something new\.\s*Allow it\? \(y\/n\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onAnswer.mock.calls).toEqual([['once'], ['reject']]);
  });
});
