import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// TerminalView pulls in xterm, which needs a canvas jsdom lacks. The dialog
// does not use it.
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));

import { HostKeyDialog } from '../components/terminal/TerminalView';

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
});
