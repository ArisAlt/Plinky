# Security

Thyrion stores passwords and types them into remote devices, so security
reports are welcome and taken seriously.

## Reporting a vulnerability

Please report it **privately**, not in a public issue:

1. Go to the repository's **Security** tab and choose **Report a
   vulnerability** (https://github.com/ArisAlt/Thyrion/security/advisories/new).
2. Describe what an attacker could do, and how to reproduce it. Use
   placeholder hosts (`192.0.2.10`) and never include real passwords.

If that page isn't available, open an issue titled **"Security contact"**
with no details, and the maintainer will get in touch to take the report
privately.

You can expect a first reply within a week. Fixes go out in a new release;
the report is credited in its notes unless you'd rather not.

## Supported versions

Only the **latest release** gets security fixes. Thyrion updates often; please
update before reporting.

## In scope

- The password vault and anything that could reveal its contents
- Automatic logins: SSH, jump hosts, enable passwords, console login
- Anything that lets a remote device, a session's output or a file make
  Thyrion run commands or send input it shouldn't
- Saved sessions, logs, exports and temporary files

How passwords are kept and used is described in
[docs/PASSWORDS.md](docs/PASSWORDS.md).

## Out of scope

- Problems in PuTTY itself: report those to PuTTY's authors.
- Attacks that need malware already running as your user, or physical
  access to an unlocked computer with the vault unlocked.
