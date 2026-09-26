import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOutputAcker, ACK_BATCH_BYTES } from '../services/tauriBridge';

describe('acknowledging terminal output (ADR-006)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends one acknowledgement per batch, not one per chunk', () => {
    const send = vi.fn();
    const acker = createOutputAcker('tab-1', send);
    for (let i = 0; i < 64; i++) acker.ack(4096); // 256 KB in 4 KB chunks
    expect(send).toHaveBeenCalledTimes((64 * 4096) / ACK_BATCH_BYTES);
    expect(send).toHaveBeenCalledWith('tab-1', ACK_BATCH_BYTES);
  });

  it('acknowledges the tail of a burst shortly after, so the backend is never left waiting', () => {
    const send = vi.fn();
    const acker = createOutputAcker('tab-1', send);
    acker.ack(100);
    acker.ack(50);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(send).toHaveBeenCalledWith('tab-1', 150);
  });

  it('flushes what is owed when the view goes away', () => {
    const send = vi.fn();
    const acker = createOutputAcker('tab-1', send);
    acker.ack(10);
    acker.dispose();
    expect(send).toHaveBeenCalledWith('tab-1', 10);
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
