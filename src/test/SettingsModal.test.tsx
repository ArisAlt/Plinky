import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SettingsModal } from '../components/modals/SettingsModal';

// Mock tauriBridge detectPutty
vi.mock('../services/tauriBridge', () => ({
  detectPutty: vi.fn().mockResolvedValue({
    found: true,
    path: '/usr/bin/plink',
    version: '0.85',
  }),
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
});
