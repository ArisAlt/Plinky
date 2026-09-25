import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listPuttySessions, writePuttySession } from '../services/tauriBridge';
import { PuttySession } from '../types/session';

// Drives the real bridge functions against a mocked Tauri IPC layer, so these
// assert on the exact payload the Rust write_putty_session command receives.
describe('tauriBridge session save/load', () => {
  let invocations: { cmd: string; args: any }[];
  let listResponse: any[];

  beforeEach(() => {
    localStorage.clear();
    invocations = [];
    listResponse = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any) => {
        invocations.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) });
        if (cmd === 'list_putty_sessions') return listResponse;
        return null;
      },
      transformCallback: () => 1,
    };
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  const lastWrite = () => invocations.filter(i => i.cmd === 'write_putty_session').pop()!.args.session;

  it('preserves log_file_name so an edit does not wipe a PuTTY LogFileName', async () => {
    const session: PuttySession = {
      name: 'Logged', protocol: 'SSH', hostname: 'h', port: 22,
      log_file_name: '/home/ops/putty.log', extra: {},
    };
    await writePuttySession(session);
    expect(lastWrite().log_file_name).toBe('/home/ops/putty.log');
  });

  it('drops a stale PlinkyTags from extra when every tag is cleared', async () => {
    const session: PuttySession = {
      name: 'Tagged', protocol: 'SSH', hostname: 'h', port: 22,
      tags: [], extra: { PlinkyTags: 'alpha,beta', TerminalType: 'xterm-256color' },
    };
    await writePuttySession(session);
    expect(lastWrite().extra.PlinkyTags).toBeUndefined();
    expect(lastWrite().extra.TerminalType).toBe('xterm-256color');
  });

  it('maps PuTTY lowercase protocols onto the Protocol type', async () => {
    listResponse = ['ssh', 'serial', 'telnet', 'rlogin', 'raw'].map((p, i) => ({
      name: `s${i}`, host_name: 'h', port_number: 22, protocol: p, extra: {},
    }));
    const sessions = await listPuttySessions();
    expect(sessions.map(s => s.protocol)).toEqual(['SSH', 'Serial', 'Telnet', 'Rlogin', 'RAW']);
  });
});
