import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PasteConfirmHost } from '../components/common/PasteConfirmHost';
import {
  askPaste, needsPasteConfirm, pasteLineCount, endsWithLineBreak,
  getPasteConfirmMode, setPasteConfirmMode, DEFAULT_PASTE_CONFIRM,
} from '../services/pasteConfirm';

const CONFIG = 'interface Gi0/1\n description uplink\n no shutdown\n';

describe('when the paste window appears', () => {
  beforeEach(() => localStorage.clear());

  it('asks before a multi-line paste by default', () => {
    expect(getPasteConfirmMode()).toBe(DEFAULT_PASTE_CONFIRM);
    expect(needsPasteConfirm(CONFIG)).toBe(true);
    // One line with its Enter is still one command.
    expect(needsPasteConfirm('show ip int brief\n')).toBe(false);
  });

  it('can ask before every paste, or never', () => {
    expect(needsPasteConfirm('show version', 'always')).toBe(true);
    expect(needsPasteConfirm(CONFIG, 'never')).toBe(false);
    expect(needsPasteConfirm('', 'always')).toBe(false);
  });

  it('remembers the choice', () => {
    setPasteConfirmMode('always');
    expect(getPasteConfirmMode()).toBe('always');
  });

  it('counts lines as the device receives them', () => {
    expect(pasteLineCount(CONFIG)).toBe(3);
    expect(pasteLineCount('a\r\nb')).toBe(2);
    expect(pasteLineCount('one')).toBe(1);
    expect(endsWithLineBreak(CONFIG)).toBe(true);
    expect(endsWithLineBreak('no shutdown')).toBe(false);
  });
});

describe('the paste window', () => {
  beforeEach(() => localStorage.clear());

  const open = (req: Parameters<typeof askPaste>[0]) => {
    render(<PasteConfirmHost />);
    let result!: Promise<string | null>;
    act(() => { result = askPaste(req); });
    return result;
  };

  it('shows the exact text, the line count and the target', async () => {
    const result = open({ text: CONFIG, target: 'R1' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Paste 3 lines into R1?');
    expect(screen.getByLabelText('Text to paste')).toHaveValue(CONFIG);
    expect(screen.getByText(/last line runs as soon as it is pasted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await expect(result).resolves.toBe(CONFIG);
  });

  it('pastes the text as edited', async () => {
    const result = open({ text: CONFIG, target: 'R1' });
    fireEvent.change(screen.getByLabelText('Text to paste'), { target: { value: 'interface Gi0/2\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await expect(result).resolves.toBe('interface Gi0/2\n');
  });

  it('has Paste focused, and Escape cancels', async () => {
    const result = open({ text: CONFIG, target: 'R1' });
    expect(screen.getByRole('button', { name: 'Paste' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(result).resolves.toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says when the session sends it one line at a time', () => {
    open({ text: CONFIG, target: 'SW1', lineDelayMs: 200 });
    expect(screen.getByText(/sent one line at a time, 200 ms apart/)).toBeInTheDocument();
  });

  it('keeps a password off the screen until Show', async () => {
    const result = open({ text: 'S3cret-Enable', target: 'R1', sensitive: true });
    expect(screen.queryByLabelText('Text to paste')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('S3cret-Enable');
    fireEvent.click(screen.getByRole('button', { name: /Show/ }));
    expect(screen.getByLabelText('Text to paste')).toHaveValue('S3cret-Enable');
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await expect(result).resolves.toBe('S3cret-Enable');
  });

  it("turns itself off with Don't ask again", async () => {
    const result = open({ text: CONFIG, target: 'R1' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await expect(result).resolves.toBe(CONFIG);
    expect(getPasteConfirmMode()).toBe('never');
  });

  it('cannot paste an emptied text box', async () => {
    const result = open({ text: CONFIG, target: 'R1' });
    fireEvent.change(screen.getByLabelText('Text to paste'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Paste' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(result).resolves.toBeNull();
  });
});
