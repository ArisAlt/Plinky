import { describe, it, expect } from 'vitest';
import { classifyPasswordPrompt, appendRecentOutput } from '../services/promptDetect';

describe('classifyPasswordPrompt', () => {
  it('treats the SSH login prompt as the login password', () => {
    expect(classifyPasswordPrompt("citizenzero@10.10.10.10's password: ")).toBe('login');
    expect(classifyPasswordPrompt('Password:')).toBe('login');
  });

  it("recognises Cisco IOS's enable prompt, which is a bare Password:", () => {
    // It used to offer the login password here: only "Enable password:" matched.
    expect(classifyPasswordPrompt('\r\nSwitch>enable\r\nPassword: ')).toBe('enable');
    expect(classifyPasswordPrompt('Switch>en\r\nPassword:')).toBe('enable');
    expect(classifyPasswordPrompt('Enable password: ')).toBe('enable');
  });

  it('is not fooled by a Password: that has scrolled past', () => {
    expect(classifyPasswordPrompt('Password:\r\nLast login: Thu\r\nuser@host:~$ ')).toBeNull();
    expect(classifyPasswordPrompt('Switch#')).toBeNull();
  });

  it('keeps a bounded tail without escape sequences, across chunks', () => {
    let buf = appendRecentOutput('', 'Switch>ena');
    buf = appendRecentOutput(buf, 'ble\r\n\x1b[1mPassword:\x1b[0m ');
    expect(classifyPasswordPrompt(buf)).toBe('enable');
    expect(appendRecentOutput('', 'x'.repeat(1000)).length).toBe(300);
  });
});
