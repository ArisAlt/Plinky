import { describe, it, expect } from 'vitest';
import { fatalHint } from '../services/fatalHint';

describe('fatal error hints', () => {
  it('a refused connection points at the port and the service', () => {
    // Verbatim plink 0.81 against a closed port.
    expect(fatalHint('FATAL ERROR: Connection refused\r\n', '10.20.0.11', 22)).toMatch(/Nothing is listening on 10\.20\.0\.11:22/);
  });
  it('a timeout points at the address, firewall or VPN', () => {
    expect(fatalHint('FATAL ERROR: Network error: Connection timed out', 'edge-rtr2', 22)).toMatch(/No answer from edge-rtr2:22/);
  });
  it('an unknown name says so', () => {
    expect(fatalHint('FATAL ERROR: Host does not exist', 'core-sw9')).toMatch(/doesn.t resolve/);
  });
  it('text without a fatal error gets nothing', () => {
    expect(fatalHint('Connection refused by policy', 'x', 22)).toBeNull();
  });
});
