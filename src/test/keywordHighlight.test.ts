import { describe, it, expect } from 'vitest';
import { findHighlights } from '../services/keywordHighlight';

const words = (line: string) => findHighlights(line).map(h => [line.slice(h.start, h.end), h.color]);
const RED = '#f87171', AMBER = '#fbbf24', GREEN = '#34d399', CYAN = '#22d3ee', VIOLET = '#c4b5fd';

describe('network keyword highlighting', () => {
  it('colours a show ip interface brief row', () => {
    expect(words('GigabitEthernet0/1     10.0.0.1        YES manual up                    up')).toEqual([
      ['GigabitEthernet0/1', VIOLET], ['10.0.0.1', CYAN], ['up', GREEN], ['up', GREEN],
    ]);
    expect(words('Gi0/2   unassigned  YES unset  administratively down down')).toEqual([
      ['Gi0/2', VIOLET], ['administratively down', RED], ['down', RED],
    ]);
  });

  it('colours syslog lines by severity and IOS command errors', () => {
    expect(words('%LINK-3-UPDOWN: Interface Gi1/0/1, changed state to down')).toEqual([
      ['%LINK-3-UPDOWN', RED], ['Gi1/0/1', VIOLET], ['down', RED],
    ]);
    expect(words('%SYS-4-CONFIG_RESOLVE: ...')[0]).toEqual(['%SYS-4-CONFIG_RESOLVE', AMBER]);
    expect(words('%SYS-5-CONFIG_I: Configured from console')[0]).toEqual(['%SYS-5-CONFIG_I', CYAN]);
    expect(words("% Invalid input detected at '^' marker.")[0][1]).toBe(RED);
  });

  it('marks err-disabled, MACs and prefixes', () => {
    expect(words('Gi0/3 err-disabled')).toContainEqual(['err-disabled', RED]);
    expect(words('0050.56a1.b2c3 DYNAMIC Gi0/4')).toContainEqual(['0050.56a1.b2c3', CYAN]);
    expect(words('route 192.168.10.0/24 via ge-0/0/1.0')).toEqual([['192.168.10.0/24', CYAN], ['ge-0/0/1.0', VIOLET]]);
  });

  it('matches whole words only, and never overlaps', () => {
    expect(words('backup setup countdown')).toEqual([]);
    const hits = findHighlights('Et1 up up up down 10.0.0.300');
    for (let i = 1; i < hits.length; i++) expect(hits[i].start).toBeGreaterThanOrEqual(hits[i - 1].end);
    expect(words('warning: link flapping')).toEqual([['warning', AMBER], ['flapping', AMBER]]);
  });
});
