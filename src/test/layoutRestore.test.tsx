import { describe, it, expect } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import { App } from '../App';

describe('starting the app', () => {
  it('brings back the tabs that were open', async () => {
    // The layout-saving effect ran on the first render, saw no tabs and
    // cleared the saved layout, before startup (after an await) read it:
    // no tab ever came back after a restart.
    const tab = (id: string) => ({ id, title: id, sessionName: `telnet://192.0.2.13:${id}`, syncChannel: 'none', hostname: '192.0.2.13', port: 5000, protocol: 'Telnet' });
    localStorage.setItem('plinky_layout_state_v1', JSON.stringify({
      schema_version: 1, layoutMode: 'single', activeTabId: 'R2',
      tabs: [tab('R1'), tab('R2')], timestamp: Date.now(),
    }));
    render(<App />);
    await screen.findAllByText('Edge Gateway Router'); // startup done
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const ids = Array.from(document.querySelectorAll('[data-tab-id]')).map(e => e.getAttribute('data-tab-id'));
    expect(ids).toEqual(['R1', 'R2']);
    expect(document.querySelector('[data-tab-active="true"]')?.getAttribute('data-tab-id')).toBe('R2');
  });
});
