import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act, screen } from '@testing-library/react';
import { App } from '../App';

// jsdom has no DragEvent: keep the pointer position the before/after
// choice reads.
class DragEventWithPointer extends MouseEvent {
  dataTransfer: unknown;
  constructor(type: string, init: MouseEventInit & { dataTransfer?: unknown } = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer;
  }
}
(globalThis as { DragEvent?: unknown }).DragEvent = DragEventWithPointer;

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: '' });
const tabEl = (id: string) => document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;
const tabOrder = () => Array.from(document.querySelectorAll('[data-tab-id]')).map(e => e.getAttribute('data-tab-id'));

const tab = (id: string) => ({ id, title: id, sessionName: `telnet://192.0.2.13:${id}`, syncChannel: 'none', hostname: '192.0.2.13', port: 5000, protocol: 'Telnet' });

describe('connection tabs', () => {
  it('a tab dragged onto another goes before or after it, and the order is kept', async () => {
    // Owner: "make connection tabs able to move, drag them".
    localStorage.setItem('plinky_layout_state_v1', JSON.stringify({
      schema_version: 1, layoutMode: 'single', activeTabId: 'SW1',
      tabs: [tab('SW1'), tab('R1'), tab('R2')], timestamp: Date.now(),
    }));
    render(<App />);
    await screen.findAllByText('Edge Gateway Router'); // sessions and layout loaded
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(tabOrder()).toEqual(['SW1', 'R1', 'R2']);

    // jsdom has no layout: clientX 0 is a tab's left half, 1 its right.
    const drag = (from: string, onto: string, after: boolean) => {
      fireEvent.dragStart(tabEl(from), { dataTransfer: dataTransfer() });
      fireEvent.dragOver(tabEl(onto), { clientX: after ? 1 : 0, dataTransfer: dataTransfer() });
      fireEvent.drop(tabEl(onto), { clientX: after ? 1 : 0, dataTransfer: dataTransfer() });
    };
    act(() => drag('R2', 'SW1', false));
    expect(tabOrder()).toEqual(['R2', 'SW1', 'R1']);
    act(() => drag('R2', 'R1', true));
    expect(tabOrder()).toEqual(['SW1', 'R1', 'R2']);

    // The saved layout follows: a restart opens them in this order.
    act(() => drag('SW1', 'R2', true));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    const saved = JSON.parse(localStorage.getItem('plinky_layout_state_v1')!);
    expect(saved.tabs.map((t: { id: string }) => t.id)).toEqual(['R1', 'R2', 'SW1']);
  });
});
