// A next step for plink's fatal errors. "FATAL ERROR: Connection refused"
// in red was the whole story, with nothing on what to try.

const HINTS: [RegExp, (t: string) => string][] = [
  [/Connection refused/i, t => `Nothing is listening on ${t}. Check the port, and that the SSH or Telnet service is running there.`],
  [/timed out/i, t => `No answer from ${t}. Check the address, a firewall in between, or whether a VPN is needed.`],
  [/No route to host|Network is unreachable/i, t => `${t} can't be reached from this machine. Check the network or VPN.`],
  [/Host does not exist|Name or service not known|nodename nor servname|No such host/i, () => 'That name doesn’t resolve. Check the spelling, or use the IP address.'],
  [/Remote side unexpectedly closed|Connection reset/i, t => `${t} closed the connection. The server may limit connections or have restarted.`],
  // plink 0.81 through a jump host that won't forward (NX-OS, IOS):
  // "fatal error in proxy SSH connection: Server refused to open main
  // channel: Administratively prohibited [open failed]".
  [/Administratively prohibited|refused to open main channel/i, () => 'The jump host refused to forward the connection, as routers and switches do. In the session\u2019s Jump Host tab choose \u201cDevice command line\u201d.'],
  [/No supported authentication methods/i, () => 'The server accepts none of the login methods offered. It may need a key (Credentials tab) instead of a password.'],
];

/** One line to show under a plink FATAL ERROR, or null. */
export function fatalHint(text: string, host?: string, port?: number): string | null {
  if (!/FATAL ERROR/.test(text)) return null;
  const target = host ? `${host}${port ? `:${port}` : ''}` : 'the server';
  for (const [rx, hint] of HINTS) if (rx.test(text)) return hint(target);
  return null;
}

/** A Telnet or Raw session that reached an SSH server: it answers with its
 *  version line ("SSH-2.0-Cisco-1.25") and closes. Seen with a copy of an
 *  EVE-NG telnet console session re-pointed at a router's port 22, still
 *  set to Telnet: "Session closed" with nothing to say why. */
export function sshBannerHint(text: string, protocol?: string): string | null {
  if (protocol !== 'Telnet' && protocol !== 'RAW') return null;
  if (!/^SSH-(?:2\.0|1\.99)-/m.test(text)) return null;
  return `This server speaks SSH, but the session is set to ${protocol === 'RAW' ? 'Raw' : 'Telnet'}. Edit the session and choose SSH as the protocol.`;
}
