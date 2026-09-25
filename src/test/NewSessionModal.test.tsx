import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NewSessionModal } from '../components/modals/NewSessionModal';

vi.mock('../services/tauriBridge', () => ({
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
    const jumpCheckbox = screen.getByRole('checkbox');
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
          ProxyMethod: '5',
          ProxyHost: 'jump.corp.com',
          ProxyPort: '22',
          ProxyUsername: 'sec_admin',
          PlinkyJumpHost: '1',
        }),
      })
    );
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
});
