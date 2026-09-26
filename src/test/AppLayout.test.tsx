import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App } from '../App';

describe('the layout buttons', () => {
  it('the 2x2 grid button returns, even with fewer than four tabs open', async () => {
    // It filled the grid with `while (tabs.length < 4)` over a state value
    // that never changes inside the handler: with saved sessions and fewer
    // than four tabs this click never returned, and froze the window.
    render(<App />);
    await screen.findAllByText('Edge Gateway Router'); // saved sessions loaded
    const grid = screen.getByTitle('4-Terminal Cluster Grid (2x2)');
    fireEvent.click(grid);
    expect(grid.className).toContain('bg-sky-500/20');
    // And it didn't open anything by itself.
    expect(screen.queryAllByTitle('Double-click to rename')).toHaveLength(0);
  });
});
