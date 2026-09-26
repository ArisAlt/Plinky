import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NewSessionModal } from '../components/modals/NewSessionModal';

const mockVaultListEntriesMeta = vi.fn().mockResolvedValue([
  { id: 'router-cisco-core', has_enable_secret: true },
]);
const mockVaultSetEntry = vi.fn().mockResolvedValue(true);

vi.mock('../services/tauriBridge', () => ({
  VAULT_CHANGED_EVENT: 'plinky:vault-changed',
  listSerialPorts: vi.fn().mockResolvedValue([
    {
      port_name: '/dev/ttyUSB0',
      display_name: '/dev/ttyUSB0 (FTDI FT232R USB UART)',
      is_usb: true,
      manufacturer: 'FTDI',
      product: 'FT232R USB UART',
    },
    {
      port_name: '/dev/ttyACM0',
      display_name: '/dev/ttyACM0 (Cisco USB Console)',
      is_usb: true,
      manufacturer: 'Cisco',
      product: 'USB Console',
    },
    {
      port_name: '/dev/ttyS0',
      display_name: '/dev/ttyS0 (Serial Port)',
      is_usb: false,
    },
  ]),
  vaultListEntriesMeta: (...args: any[]) => mockVaultListEntriesMeta(...args),
  vaultSetEntry: (...args: any[]) => mockVaultSetEntry(...args),
}));

describe('NewSessionModal Component', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(
      <NewSessionModal
        isOpen={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders standard SSH session fields and saves properly', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <NewSessionModal
        isOpen={true}
        onClose={onClose}
        onSave={onSave}
      />
    );

    expect(screen.getByText('New PuTTY Session')).toBeDefined();

    // Fill in standard SSH session
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), {
      target: { value: 'Web-01' },
    });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), {
      target: { value: '10.0.0.10' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Web-01',
        hostname: '10.0.0.10',
        port: 22,
        protocol: 'SSH',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('switches to Serial protocol, lists detected USB ports, and saves PuTTY Serial keys', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <NewSessionModal
        isOpen={true}
        onClose={onClose}
        onSave={onSave}
      />
    );

    // Switch protocol to Serial
    const protocolSelect = screen.getByDisplayValue(/SSH/i);
    fireEvent.change(protocolSelect, { target: { value: 'Serial' } });

    // Verify Serial Hardware section is displayed
    expect(screen.getByText('Serial Port & Hardware Line Settings')).toBeDefined();

    // Verify detected USB ports are populated
    await waitFor(() => {
      expect(screen.getByText(/● \/dev\/ttyUSB0/i)).toBeDefined();
      expect(screen.getByText(/● \/dev\/ttyACM0/i)).toBeDefined();
    });

    // Fill Session name
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Cisco Console Cable/i), {
      target: { value: 'Cisco-Switch-Console' },
    });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cisco-Switch-Console',
        hostname: '/dev/ttyUSB0',
        protocol: 'Serial',
        extra: expect.objectContaining({
          SerialLine: '/dev/ttyUSB0',
          SerialSpeed: '9600',
          SerialDataBits: '8',
          SerialStopHalfbits: '2',
        }),
      })
    );
  });

  it('renders MobaXterm-style visual Jump Host topology and saves Proxy keys', () => {
    const onSave = vi.fn();

    render(
      <NewSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    // Fill in target server
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), {
      target: { value: 'Internal-DB' },
    });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), {
      target: { value: '10.0.1.50' },
    });

    // Enable Jump Host checkbox
    const jumpCheckbox = screen.getByLabelText(/Connect through SSH Jump Host/i);
    fireEvent.click(jumpCheckbox);

    // Verify visual topology route banner is rendered
    expect(screen.getByText('Client')).toBeDefined();
    expect(screen.getByText('Bastion')).toBeDefined();
    expect(screen.getByText('10.0.1.50')).toBeDefined();

    // Enter Jump Host details
    fireEvent.change(screen.getByPlaceholderText(/bastion\.internal/i), {
      target: { value: 'jump.corp.com' },
    });
    fireEvent.change(screen.getByPlaceholderText(/bastion_user/i), {
      target: { value: 'sec_admin' },
    });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Internal-DB',
        hostname: '10.0.1.50',
        extra: expect.objectContaining({
          ProxyMethod: '6', // PuTTY's SSH proxy; '5' (local command) never logged in
          ProxyHost: 'jump.corp.com',
          ProxyPort: '22',
          ProxyUsername: 'sec_admin',
          PlinkyJumpHost: '1',
        }),
      })
    );
    expect(onSave.mock.calls[0][0].extra.ProxyTelnetCommand).toBeUndefined();
  });
  // An existing serial session as the owner has it: saved by PuTTY, line in
  // extra, the adapter possibly unplugged.
  const savedSerial = (line: string) => ({
    name: 'COM USB0',
    hostname: '',
    port: 0,
    protocol: 'Serial' as const,
    extra: {
      SerialLine: line,
      SerialSpeed: '9600',
      SerialDataBits: '8',
      SerialStopHalfbits: '2',
      SerialParity: '0',
      SerialFlowControl: '1',
    },
  });

  it('keeps the saved port when the scan finishes after the session loads', async () => {
    // /dev/ttyACM0 is detected but not first; the scan used to overwrite the
    // saved line with the first USB port it found.
    const onSave = vi.fn();
    render(
      <NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} editingSession={savedSerial('/dev/ttyACM0')} />
    );
    await waitFor(() => expect(screen.getByText(/● \/dev\/ttyUSB0/)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ SerialLine: '/dev/ttyACM0' }) })
    );
  });

  it('shows a saved port that is unplugged as not connected, and keeps it', async () => {
    const onSave = vi.fn();
    render(
      <NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} editingSession={savedSerial('/dev/ttyUSB7')} />
    );
    await waitFor(() => expect(screen.getByText(/● \/dev\/ttyUSB0/)).toBeDefined());

    // The select displays the saved port, marked as absent -- not whichever
    // detected port happened to be listed first.
    expect(screen.getByDisplayValue('○ /dev/ttyUSB7 (not connected)')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ SerialLine: '/dev/ttyUSB7' }) })
    );
  });

  it('saves session with new encrypted vault credentials including network device enable password', async () => {
    const onSave = vi.fn();
    mockVaultSetEntry.mockClear();

    render(
      <NewSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    // Session name & host
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), {
      target: { value: 'Cisco-Core-Router' },
    });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), {
      target: { value: '192.168.1.1' },
    });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. root, admin, or deploy/i), {
      target: { value: 'cisco_admin' },
    });

    // Check "Save credentials in Encrypted Vault"
    const vaultCheckbox = screen.getByLabelText(/Save credentials in Encrypted Vault/i);
    fireEvent.click(vaultCheckbox);

    // Fill in Vault Key ID and Login Password
    const keyInput = screen.getByPlaceholderText(/session:Cisco-Core-Router/i);
    fireEvent.change(keyInput, { target: { value: 'cisco-core-vault-key' } });

    const pwdInput = screen.getByPlaceholderText(/Session login password\.\.\./i);
    fireEvent.change(pwdInput, { target: { value: 'adminSecret123' } });

    // Enable Network Device checkbox
    const netDevCheckbox = screen.getByLabelText(/Network Device \(requires Enable Password \/ Privileged Exec\)/i);
    fireEvent.click(netDevCheckbox);

    // Fill in Enable Password
    const enablePwdInput = screen.getByPlaceholderText(/e\.g\. Cisco enable secret\.\.\./i);
    fireEvent.change(enablePwdInput, { target: { value: 'ciscoPrivilegedSecret456' } });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));

    // Verify vaultSetEntry called with credentials including enable_secret
    expect(mockVaultSetEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cisco-core-vault-key',
        username: 'cisco_admin',
        secret: 'adminSecret123',
        enable_secret: 'ciscoPrivilegedSecret456',
      })
    );

    // Verify onSave session has PlinkyVaultKey and NO plaintext password.
    // The session is saved only after the vault accepted the entry.
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cisco-Core-Router',
        hostname: '192.168.1.1',
        extra: expect.objectContaining({
          PlinkyVaultKey: 'cisco-core-vault-key',
        }),
      })
    ));
  });

  // Fills in a new session with "Save credentials in Encrypted Vault" ticked.
  const fillVaultSession = (password: string, enable?: string) => {
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), { target: { value: 'Core-SW' } });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), { target: { value: '192.168.1.2' } });
    fireEvent.click(screen.getByLabelText(/Save credentials in Encrypted Vault/i));
    if (password) {
      fireEvent.change(screen.getByPlaceholderText(/Session login password\.\.\./i), { target: { value: password } });
    }
    if (enable !== undefined) {
      fireEvent.click(screen.getByLabelText(/Network Device \(requires Enable Password \/ Privileged Exec\)/i));
      fireEvent.change(screen.getByPlaceholderText(/e\.g\. Cisco enable secret\.\.\./i), { target: { value: enable } });
    }
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));
  };

  it('keeps the dialog open and says so when the vault refuses the password', async () => {
    // With the vault locked this used to fail silently: the dialog closed,
    // the session was linked to an entry that didn't exist, the password was gone.
    mockVaultSetEntry.mockRejectedValueOnce('Vault is locked');
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<NewSessionModal isOpen={true} onClose={onClose} onSave={onSave} />);
    fillVaultSession('pw');
    expect(await screen.findByText(/The password wasn't saved: Vault is locked/)).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not link a session to a vault entry that was never created', async () => {
    const onSave = vi.fn();
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} />);
    fillVaultSession('');
    expect(await screen.findByText(/Enter the password to save in the vault/)).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('stores an enable password exactly as typed', async () => {
    mockVaultSetEntry.mockClear();
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={vi.fn()} />);
    fillVaultSession('pw', ' en able ');
    await waitFor(() => expect(mockVaultSetEntry).toHaveBeenCalledWith(
      expect.objectContaining({ enable_secret: ' en able ' })
    ));
  });

  it('links session to existing encrypted vault entry', async () => {
    const onSave = vi.fn();
    mockVaultSetEntry.mockClear();

    render(
      <NewSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), {
      target: { value: 'Switch-01' },
    });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), {
      target: { value: '192.168.1.2' },
    });

    // Check "Save credentials in Encrypted Vault"
    const vaultCheckbox = screen.getByLabelText(/Save credentials in Encrypted Vault/i);
    fireEvent.click(vaultCheckbox);

    // Switch to "Link to Existing Vault Entry" mode
    const linkModeBtn = screen.getByRole('button', { name: /Link to Existing/i });
    fireEvent.click(linkModeBtn);

    // Wait for vault entries to load
    await waitFor(() => {
      expect(screen.getByText(/router-cisco-core/)).toBeDefined();
    });

    // Select existing vault key
    const vaultSelect = screen.getByDisplayValue(/-- Select a vault credential --/i);
    fireEvent.change(vaultSelect, { target: { value: 'router-cisco-core' } });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));

    // Should NOT call vaultSetEntry since it's linking existing
    expect(mockVaultSetEntry).not.toHaveBeenCalled();

    // Session has linked PlinkyVaultKey
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Switch-01',
        extra: expect.objectContaining({
          PlinkyVaultKey: 'router-cisco-core',
        }),
      })
    );
  });

  it('saves the automation opt-ins, and "log in automatically" only for Telnet/serial', async () => {
    const onSave = vi.fn();
    const { unmount } = render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), { target: { value: 'SW1' } });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), { target: { value: '10.0.0.2' } });
    expect(screen.queryByLabelText(/Log in automatically/i)).toBeNull(); // SSH logs in by itself
    fireEvent.click(screen.getByLabelText(/Send enable password automatically/i));
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].extra.PlinkyAutoEnable).toBe('1');
    expect(onSave.mock.calls[0][0].extra.PlinkyAutoLogin).toBeUndefined();
    unmount();

    const onSave2 = vi.fn();
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave2} />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), { target: { value: 'Old-SW' } });
    fireEvent.change(screen.getByDisplayValue(/SSH/i), { target: { value: 'Telnet' } });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), { target: { value: '10.0.0.3' } });
    fireEvent.click(screen.getByLabelText(/Log in automatically/i));
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));
    await waitFor(() => expect(onSave2).toHaveBeenCalled());
    expect(onSave2.mock.calls[0][0].extra.PlinkyAutoLogin).toBe('1');
    expect(onSave2.mock.calls[0][0].extra.PlinkyAutoEnable).toBeUndefined();
  });

  it('stores a saved bastion session by name, so its own key and user apply', async () => {
    const onSave = vi.fn();
    const bastion = { name: 'Bastion-1', hostname: '203.0.113.5', port: 2222, protocol: 'SSH' as const, username: 'jumper' };
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} savedSessions={[bastion]} />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), { target: { value: 'Inner' } });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), { target: { value: '10.0.0.9' } });
    fireEvent.click(screen.getByLabelText(/Connect through SSH Jump Host/i));
    fireEvent.change(screen.getByDisplayValue(/Select a saved bastion host/i), { target: { value: 'Bastion-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const extra = onSave.mock.calls[0][0].extra;
    expect(extra.ProxyMethod).toBe('6');
    expect(extra.ProxyHost).toBe('Bastion-1');
    expect(extra.ProxyUsername).toBeUndefined();
  });

  it("leaves a PuTTY HTTP proxy alone: it isn't a jump host and isn't wiped on save", async () => {
    // Any ProxyHost used to count as a jump host, and saving without one
    // deleted every Proxy* key -- a proxy set up in real PuTTY was lost.
    const onSave = vi.fn();
    const viaHttpProxy = {
      name: 'Behind-Proxy', hostname: '198.51.100.7', port: 22, protocol: 'SSH' as const,
      extra: { ProxyMethod: '3', ProxyHost: 'proxy.corp', ProxyPort: '3128', ProxyUsername: 'me' },
    };
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} editingSession={viaHttpProxy} />);
    expect((screen.getByLabelText(/Connect through SSH Jump Host/i) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].extra).toMatchObject({ ProxyMethod: '3', ProxyHost: 'proxy.corp', ProxyPort: '3128', ProxyUsername: 'me' });
  });

  it('saves the paste line delay and tells open terminals', async () => {
    const onSave = vi.fn();
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener('plinky:session-saved', listener);
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), { target: { value: 'Console-SW' } });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), { target: { value: '10.0.0.5' } });
    fireEvent.change(screen.getByLabelText('Paste line delay in milliseconds'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    window.removeEventListener('plinky:session-saved', listener);
    expect(onSave.mock.calls[0][0].extra.PlinkyPasteLineDelayMs).toBe('250');
    expect(heard).toEqual([{ name: 'Console-SW', pasteLineDelayMs: 250, autoReconnect: false }]);
  });

  it('removes the paste line delay when set back to 0', async () => {
    const onSave = vi.fn();
    const paced = { name: 'SW', hostname: '10.0.0.6', port: 22, protocol: 'SSH' as const, extra: { PlinkyPasteLineDelayMs: '400' } };
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} editingSession={paced} />);
    const field = screen.getByLabelText('Paste line delay in milliseconds') as HTMLInputElement;
    expect(field.value).toBe('400');
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].extra.PlinkyPasteLineDelayMs).toBeUndefined();
  });

  it('saves keepalive and auto-reconnect the way PuTTY and Plinky read them', async () => {
    const onSave = vi.fn();
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener('plinky:session-saved', listener);
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Production Web Server/i), { target: { value: 'Edge' } });
    fireEvent.change(screen.getByPlaceholderText(/192\.0\.2\.10/i), { target: { value: '10.0.0.1' } });
    fireEvent.change(screen.getByLabelText('Keepalive interval in seconds'), { target: { value: '90' } });
    fireEvent.click(screen.getByLabelText(/TCP keepalives/i));
    fireEvent.click(screen.getByLabelText(/Reconnect automatically/i));
    fireEvent.click(screen.getByRole('button', { name: /save putty session/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    window.removeEventListener('plinky:session-saved', listener);
    expect(onSave.mock.calls[0][0].extra).toMatchObject({
      PingInterval: '1', PingIntervalSecs: '30', TCPKeepalives: '1', PlinkyAutoReconnect: '1',
    });
    expect(heard).toEqual([expect.objectContaining({ name: 'Edge', autoReconnect: true })]);
  });

  it('shows an existing PuTTY keepalive and offers no connection options for serial', () => {
    const putty = { name: 'Old', hostname: 'h', port: 22, protocol: 'SSH' as const, extra: { PingInterval: '2', PingIntervalSecs: '5' } };
    const { unmount } = render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={vi.fn()} editingSession={putty} />);
    expect((screen.getByLabelText('Keepalive interval in seconds') as HTMLInputElement).value).toBe('125');
    unmount();
    const serial = { name: 'Con', hostname: '', port: 0, protocol: 'Serial' as const, extra: { SerialLine: '/dev/ttyUSB0' } };
    render(<NewSessionModal isOpen={true} onClose={vi.fn()} onSave={vi.fn()} editingSession={serial} />);
    expect(screen.queryByLabelText('Keepalive interval in seconds')).toBeNull();
  });
});
