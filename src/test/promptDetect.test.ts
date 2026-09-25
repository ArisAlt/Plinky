import { describe, it, expect } from 'vitest';
import {
  classifyPasswordPrompt, appendRecentOutput, isUsernamePrompt, trackTypedInput, isPrivilegeCommand, TypedInput,
} from '../services/promptDetect';

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


describe('network-device automation helpers', () => {
  const type = (keys: string[], t0 = 1000) =>
    keys.reduce<TypedInput>((s, k, i) => trackTypedInput(s, k, t0 + i), { line: '', submitted: null });

  it('knows the command the user submitted, from keystrokes', () => {
    expect(type(['e', 'n', 'a', 'b', 'l', 'e', '\r']).submitted?.line).toBe('enable');
    expect(type(['e', 'n', 'x', '\x7f', '\r']).submitted?.line).toBe('en');
    expect(type(['e', 'n', '\x03', 's', 'h', '\r']).submitted?.line).toBe('sh');
  });

  it('refuses to guess a line edited with arrow keys', () => {
    // After an arrow key the visible line is unknowable -- never treat it as "enable".
    expect(type(['e', 'n', '\x1b[D', 'x', '\r']).submitted).toBeNull();
  });

  it('recognises privilege commands, not look-alikes', () => {
    for (const ok of ['enable', 'en', 'ENABLE', 'enable 15', ' ena ', 'super', 'super 3']) {
      expect(isPrivilegeCommand(ok)).toBe(true);
    }
    for (const no of ['e', 'enables', 'show enable', 'enable secret x', 'supervisor', '']) {
      expect(isPrivilegeCommand(no)).toBe(false);
    }
  });

  it('spots Username:/login: prompts', () => {
    expect(isUsernamePrompt('\r\nUser Access Verification\r\n\r\nUsername: ')).toBe(true);
    expect(isUsernamePrompt('switch login: ')).toBe(true);
    expect(isUsernamePrompt('Password: ')).toBe(false);
  });
});
