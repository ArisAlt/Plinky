import { describe, it, expect } from 'vitest';
import { fatalHint, sshBannerHint } from '../services/fatalHint';

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

describe('a Telnet session that reached an SSH server', () => {
  it('says the server speaks SSH and what to change', () => {
    // What the owner's copied EVE session printed before "Session closed".
    const out = 'SSH-2.0-Cisco-1.25\r\n';
    expect(sshBannerHint(out, 'Telnet')).toMatch(/speaks SSH, but the session is set to Telnet/);
    expect(sshBannerHint(out, 'RAW')).toMatch(/set to Raw/);
  });

  it('stays quiet for SSH sessions and ordinary output', () => {
    expect(sshBannerHint('SSH-2.0-OpenSSH_9.6\r\n', 'SSH')).toBeNull();
    expect(sshBannerHint('Router> show ssh\r\nSSH Enabled - version 2.0\r\n', 'Telnet')).toBeNull();
  });
});

describe('a Telnet session that reached an SSH server', () => {
  it('says the server speaks SSH and what to change', () => {
    // What a copied EVE telnet session printed before "Session closed".
    const out = 'SSH-2.0-Cisco-1.25\r\n';
    expect(sshBannerHint(out, 'Telnet')).toMatch(/speaks SSH, but the session is set to Telnet/);
    expect(sshBannerHint(out, 'RAW')).toMatch(/set to Raw/);
  });

  it('stays quiet for SSH sessions and ordinary output', () => {
    expect(sshBannerHint('SSH-2.0-OpenSSH_9.6\r\n', 'SSH')).toBeNull();
    expect(sshBannerHint('Router> show ssh\r\nSSH Enabled - version 2.0\r\n', 'Telnet')).toBeNull();
  });
});

describe('a jump host that will not forward', () => {
  it('points at the Device command line jump mode', () => {
    // Verbatim plink 0.81 through a jump host with forwarding refused.
    const out = 'FATAL ERROR: fatal error in proxy SSH connection: Server refused to open main channel: Administratively prohibited [open failed]\r\n';
    expect(fatalHint(out, '10.1.1.2', 22)).toMatch(/Device command line/);
  });
});
