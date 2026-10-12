# How Thyrion protects your passwords

Thyrion can remember passwords for your sessions and type them for you. This
page explains where they are kept, when they leave the vault, and what
Thyrion can and cannot protect against. It describes what the code does, not
what we hope it does; if you find a difference, please report it privately
(see [SECURITY.md](../SECURITY.md)).

## The short version

- Passwords live in **one encrypted file**, the vault. Without your master
  password the file is unreadable.
- Your **master password is never stored** anywhere. Forget it and the vault
  cannot be opened, by you or by us. There is no recovery.
- PuTTY's saved sessions hold **only the name of a vault entry**, never a
  password.
- A password leaves the vault only to **log you in, or when you ask** (reveal,
  copy, edit, export).
- While the vault is **unlocked**, anything running as your user on your
  computer could in principle reach it. Lock it when you step away.

## The vault file

| | |
|---|---|
| Where | `vault.bin` in Thyrion's data folder: `~/.local/share/com.thyrion.desktop/` on Linux, `%APPDATA%\com.thyrion.desktop\` on Windows (Plinky's, before the rename: `com.plinky.desktop`) |
| Encryption | AES-256-GCM. The file's header (format version and key settings) is authenticated too, so a changed header is rejected. |
| Key from your master password | Argon2id, 64 MiB of memory, 3 passes, a random 16-byte salt per vault. This makes guessing master passwords slow, even with the file in hand. |
| Each save | Encrypted again with a fresh random nonce, written to a new file and swapped in, so a crash can't leave half a vault. |
| File permissions | Readable by your user only (on Linux, `600`, set when the file is created). |

A vault file that asks for key settings far beyond Thyrion's own (for example
a damaged or altered file) is refused before any work is done.

## Locking and unlocking

- Unlocking turns your master password into the key and decrypts the vault
  into memory. The master password itself is not kept.
- **Locking** (the lock button, or closing Thyrion) erases the key and every
  decrypted password from memory.
- The vault **stays unlocked until you lock it or close Thyrion**. There is no
  automatic lock after a period of inactivity yet.
- Deleting the vault (Settings) asks for confirmation; it removes the file
  for good.

## When a password leaves the vault

### Logging in to an SSH session

PuTTY's `plink` reads a login password from a file, not from its command
line (where other programs could see it). Thyrion writes the password to a
temporary file **readable only by your user**, starts `plink`, and deletes
the file **5 seconds** later; `plink` has read it within milliseconds. If
Thyrion is killed in those seconds, the file is deleted the next time Thyrion
starts. The SFTP browser does the same for `psftp`.

The password is briefly on disk in your temporary folder in this way. On an
encrypted disk (BitLocker, LUKS) that is covered by the disk encryption.

### Jump hosts

- **Through a jump host (tunnel)**: Thyrion logs in to the jump host with its
  password; the connection to the device behind it runs encrypted *through*
  the jump host, so the jump host never sees the second password.
- **Through a device's command line**: Thyrion types the second device's
  `ssh` or `telnet` command and its password **into the first device**. The
  first device therefore sees that password. This is how the method works
  (it's the same as typing it yourself); use it only through devices you
  trust.

Thyrion answers only its own steps, in order, and stops if a password is
refused or a step fails, so it never retries a stored password.

### Enable passwords

With "send the enable password" on for a session, Thyrion types it only when
**you** have just typed `enable` (or `en`, `super`) yourself, within the last
5 seconds, and the device answers `Password:`. What you typed is read from
your keystrokes, not from what the device prints, so a device cannot fake
it. An enable prompt is never answered with the login password.

### Automatic console login (Telnet and serial)

With "log in automatically" on, Thyrion answers the console's `Username:` and
`Password:` prompts once per connection. It **stops as soon as you run a
command**, so a password prompt from something you started (for example
`ssh` from the console to another host) never gets the console's password.

### "Send password" and copying

- **Send password** types the password straight into the session from
  Thyrion's core; it never passes through the window's interface.
- **Copy password** puts it on the clipboard and clears the clipboard after
  25 seconds if it still holds that password. A clipboard manager may keep
  its own copy; Thyrion can't prevent that.
- **Reveal** and **edit** in the Vault screen show the password in the window
  while you are looking at it.

### Export to KeePass (.kdbx)

The export asks for your master password and protects the `.kdbx` file with
it. The file is written readable by your user only. Once exported, it is
protected by the KeePass format and the password you chose, not by Thyrion.

## What Thyrion does not protect against

- **Malware running as your user** while the vault is unlocked: it could read
  Thyrion's memory, your keystrokes or your clipboard. No password manager
  can stop that; keep your computer clean and lock the vault when away.
- **A weak master password.** Argon2id slows guessing down, it can't make a
  short or common password strong. Use a long passphrase.
- **The devices you connect to.** A password typed into a device can be
  logged or seen by whoever controls that device. Session logs record what a
  device *prints*; devices normally don't print passwords, but some echo
  them back.
- **Forgetting the master password.** There is no recovery and no back door.
  Export to KeePass from time to time if you want a backup.

## Reporting a problem

Anything that could expose passwords or keys: please report it privately, as
described in [SECURITY.md](../SECURITY.md), not in a public issue.
