import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ConfirmHost } from '../components/common/ConfirmHost';
import { askConfirm } from '../services/confirm';
import { copyName } from '../services/tauriBridge';

describe('in-app confirm', () => {
  it('Escape answers no', async () => {
    render(<ConfirmHost />);
    let answer: Promise<boolean>;
    act(() => { answer = askConfirm({ title: 'Delete it?', confirmLabel: 'Delete', danger: true }); });
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(answer!).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('the confirm button answers yes', async () => {
    render(<ConfirmHost />);
    let answer: Promise<boolean>;
    act(() => { answer = askConfirm({ title: 'Replace it?', confirmLabel: 'Replace' }); });
    fireEvent.click(await screen.findByText('Replace'));
    await expect(answer!).resolves.toBe(true);
  });
});

describe('copy names', () => {
  it('pick the first free "(copy N)"', () => {
    expect(copyName('web-1', ['web-1'])).toBe('web-1 (copy)');
    expect(copyName('web-1', ['web-1', 'web-1 (copy)', 'web-1 (copy 2)'])).toBe('web-1 (copy 3)');
  });
});
