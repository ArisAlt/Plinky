import { describe, it, expect } from 'vitest';
import { consoleLoginAction, isCommandSubmission, classifyPasswordPrompt } from '../services/promptDetect';

const base = {
  enabled: true,
  commandRun: false,
  hasUsername: true,
  sent: { user: false, password: false },
};
const at = (recent: string) => ({ ...base, recent, promptKind: classifyPasswordPrompt(recent) });

describe('automatic console login', () => {
  it('answers the console\'s own login: username, then password', () => {
    expect(consoleLoginAction(at('\r\nUser Access Verification\r\n\r\nUsername: '))).toBe('username');
    expect(consoleLoginAction({ ...at('Username: ops\r\nPassword: '), sent: { user: true, password: false } })).toBe('password');
  });

  it('stops once the user has run a command: a later Password: is not the console\'s', () => {
    // A console already at "Router>" needs no login. The user runs
    // `ssh -l admin 192.0.2.20` from it, and that host asks "Password:".
    // The console's vault password went to it -- a credential sent to a
    // host it isn't for.
    const s = at('Router>ssh -l admin 192.0.2.20\r\nPassword: ');
    expect(consoleLoginAction({ ...s, commandRun: true })).toBeNull();
  });

  it('does nothing when the session has it off, and answers each prompt once', () => {
    expect(consoleLoginAction({ ...at('Password: '), enabled: false })).toBeNull();
    expect(consoleLoginAction({ ...at('Password: '), sent: { user: true, password: true } })).toBeNull();
  });

  it('never answers an enable prompt with the login password', () => {
    expect(consoleLoginAction(at('Router>enable\r\nPassword: '))).toBeNull();
  });
});

describe('what counts as running a command', () => {
  it('a line typed at the device\'s prompt', () => {
    expect(isCommandSubmission('ssh -l admin 192.0.2.20', 'Router>')).toBe(true);
    expect(isCommandSubmission('show version', 'switch# ')).toBe(true);
  });

  it('not a username, a password, or Enter to wake the console', () => {
    expect(isCommandSubmission('ops', 'Username: ')).toBe(false);
    expect(isCommandSubmission('hunter2', 'Password: ')).toBe(false);
    expect(isCommandSubmission('', 'Router>')).toBe(false);
    expect(isCommandSubmission('   ', '')).toBe(false);
  });
});
