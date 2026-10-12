import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, screen } from '@testing-library/react';
import { assignPanes, placeInPane } from '../services/paneLayout';
import { App } from '../App';

const empty = () => [null, null, null, null];

describe('which tab each pane shows', () => {
  it('fills empty panes with tabs in tab order', () => {
    expect(assignPanes(empty(), 0, 'A', 2, ['A', 'B', 'C']).slots.slice(0, 2)).toEqual(['A', 'B']);
  });

  it('a tab picked while pane 2 is focused goes into pane 2, and pane 1 keeps its tab', () => {
    const r = assignPanes(['A', 'B', null, null], 1, 'C', 2, ['A', 'B', 'C']);
    expect(r.slots.slice(0, 2)).toEqual(['A', 'C']);
    expect(r.focused).toBe(1);
  });

  it('focus moving to pane 1 leaves pane 2 as it is', () => {
    // The bug: pane 2 went back to its old tab when the mouse left it.
    const r = assignPanes(['A', 'C', null, null], 1, 'A', 2, ['A', 'B', 'C']);
    expect(r.slots.slice(0, 2)).toEqual(['A', 'C']);
    expect(r.focused).toBe(0);
  });

  it('a new tab takes an empty pane before replacing anything', () => {
    const r = assignPanes(['A', null, null, null], 0, 'N', 2, ['A', 'N']);
    expect(r.slots.slice(0, 2)).toEqual(['A', 'N']);
    expect(r.focused).toBe(1);
  });

  it('a closed tab leaves its pane to a tab no pane shows', () => {
    expect(assignPanes(['A', 'B', null, null], 0, 'A', 2, ['A', 'C']).slots.slice(0, 2)).toEqual(['A', 'C']);
  });

  it('putting a tab shown elsewhere in a pane swaps the two', () => {
    expect(placeInPane(['A', 'B', 'C', 'D'], 0, 'C', 4)).toEqual(['C', 'B', 'A', 'D']);
  });
});

const tab = (id: string) => ({ id, title: id, sessionName: `telnet://192.0.2.13:${id}`, syncChannel: 'none', hostname: '192.0.2.13', port: 5000, protocol: 'Telnet' });
const paneTab = (i: number) => document.querySelector(`[data-pane="${i}"]`)?.getAttribute('data-pane-tab');
const paneBody = (i: number) => document.querySelector(`[data-pane="${i}"] [data-pane-body]`) as HTMLElement;
const clickTab = (id: string) => fireEvent.click(document.querySelector(`[data-tab-id="${id}"]`)!);
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

async function startWith(tabs: string[], layoutMode: string, panes?: (string | null)[]) {
  localStorage.setItem('plinky_layout_state_v1', JSON.stringify({
    schema_version: 1, layoutMode, activeTabId: tabs[0], tabs: tabs.map(tab), panes, timestamp: Date.now(),
  }));
  const view = render(<App />);
  await screen.findAllByText('Edge Gateway Router');
  await settle();
  return view;
}

describe('split panes in the app', () => {
  beforeEach(() => localStorage.clear());

  it('a tab picked for pane 2 stays there when pane 1 takes the keyboard back', async () => {
    // Owner: "when I select a tab with focus on the second terminal it
    // changes to that tab; when it loses focus it goes back".
    await startWith(['R1', 'R2', 'SW1'], 'split-vertical');
    expect([paneTab(0), paneTab(1)]).toEqual(['R1', 'R2']);
    fireEvent.click(paneBody(1)); // pane 2 focused
    await settle();
    act(() => clickTab('SW1'));
    await settle();
    expect([paneTab(0), paneTab(1)]).toEqual(['R1', 'SW1']);
    fireEvent.click(paneBody(0)); // focus leaves pane 2
    await settle();
    expect([paneTab(0), paneTab(1)]).toEqual(['R1', 'SW1']);
    // The tab bar says where each one is.
    expect(document.querySelector('[data-tab-id="SW1"] [data-tab-pane]')?.textContent).toBe('2');
    expect(document.querySelector('[data-tab-id="R2"] [data-tab-pane]')).toBeNull();
  });

  it('a pane names its tab once, in the terminal header, with the picker', async () => {
    // The pane bar's picker and the terminal header both showed the name.
    await startWith(['R1', 'R2'], 'split-vertical');
    const pane = document.querySelector('[data-pane="0"]')!;
    expect(pane.querySelectorAll('select')).toHaveLength(1);
    expect(pane.textContent).not.toContain('telnet://192.0.2.13:R1'); // the session name the header showed
    expect((screen.getByLabelText('Tab in pane 1') as HTMLSelectElement).value).toBe('R1');
  });

  it('a pane can be given any open tab from its own list', async () => {
    await startWith(['R1', 'R2', 'SW1'], 'split-horizontal');
    fireEvent.change(screen.getByLabelText('Tab in pane 1'), { target: { value: 'SW1' } });
    await settle();
    expect([paneTab(0), paneTab(1)]).toEqual(['SW1', 'R2']);
  });

  it('a tab dragged onto a pane is shown there', async () => {
    await startWith(['R1', 'R2', 'SW1'], 'grid-4');
    const dt = { setData: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(document.querySelector('[data-tab-id="SW1"]')!, { dataTransfer: dt });
    const pane0 = document.querySelector('[data-pane="0"]')!;
    fireEvent.dragOver(pane0, { dataTransfer: dt });
    fireEvent.drop(pane0, { dataTransfer: dt });
    await settle();
    expect(paneTab(0)).toBe('SW1');
    expect(paneTab(2)).toBe('R1'); // swapped with where SW1 was
  });

  it('a new session opens in the empty pane, and splitting one tab opens no second connection', async () => {
    await startWith(['R1'], 'single');
    fireEvent.click(screen.getByTitle("Split View Vertically (Side by Side)"));
    await settle();
    expect(document.querySelectorAll('[data-tab-id]')).toHaveLength(1);
    expect(paneTab(1)).toBe('');
    fireEvent.doubleClick(document.querySelector('[data-session-row="Edge Gateway Router"]')!);
    await settle();
    const ids = Array.from(document.querySelectorAll('[data-tab-id]')).map(e => e.getAttribute('data-tab-id'));
    expect(ids).toHaveLength(2);
    expect(paneTab(0)).toBe('R1');
    expect(paneTab(1)).toBe(ids[1]);
  });

  it('the panes come back after a restart', async () => {
    const { unmount } = await startWith(['R1', 'R2', 'SW1'], 'split-vertical', ['SW1', 'R1', null, null]);
    expect([paneTab(0), paneTab(1)]).toEqual(['SW1', 'R1']);
    unmount();
  });
});
