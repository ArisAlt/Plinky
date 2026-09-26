# Plinky

**A modern, open-source home for your PuTTY sessions.**

Plinky is a desktop terminal and session manager for people who live in SSH:
system administrators, network engineers and DevOps teams. It keeps PuTTY,
the tool you already trust, doing the connecting, and gives it the workspace
PuTTY never had: tabs, split screens, a file browser, a password vault and
the time-savers you reach for every day.

Your existing PuTTY sessions show up in Plinky as they are. Nothing to import,
nothing to convert, and PuTTY keeps working exactly as before.

---

## Why Plinky

**PuTTY is trusted everywhere, but it's one window per connection.** No tabs,
no file transfer pane, no way to type into ten servers at once.

**The tools that fixed that aren't open.** Popular alternatives keep their core
closed, or have stopped being maintained, and they end up holding your server
passwords and keys.

Plinky is fully open source and leaves the security-critical part, the SSH
connection itself, to PuTTY.

---

## What you can do with it

- **Open your PuTTY sessions in tabs.** The same saved sessions you use in
  PuTTY, organised in folders and subfolders, with tags and search.
- **Work side by side.** Split the window into two or four terminals, with a
  file browser next to your shell.
- **Type into many servers at once.** Group tabs into broadcast channels and
  send one command to all of them.
- **Move files without leaving the terminal.** A two-pane file browser for
  uploads, downloads and remote folders.
- **Keep passwords in an encrypted vault.** Log in automatically, including
  through a jump host, and send network devices their enable password when
  they ask for it. Passwords never go into PuTTY's session files.
- **Reach hosts behind a gateway.** Connect through a jump host / bastion with
  one setting.
- **Work with network gear.** Serial console sessions with USB adapter
  detection and Send Break, and slow line-by-line paste for devices that drop
  characters.
- **Save time.** Reusable command snippets with fill-in values, highlighted IPs
  and keywords, clickable links, and point-and-click cursor editing.
- **Keep a record.** Log any session straight to a file of your choice as it
  happens.
- **Manage tunnels and host keys** from one place.

---

## Platforms

- **Linux:** AppImage, `.deb` and `.rpm`
- **Windows:** installer and portable `.exe`

macOS is planned for later.

Plinky uses the PuTTY you already have installed, so install
[PuTTY](https://www.chiark.greenend.org.uk/~sgtatham/putty/) first.

## Download

Get the latest version from the
[Releases page](https://github.com/ArisAlt/Plinky/releases).

---

## License

Open source under the MIT or Apache-2.0 license, your choice.

*The name comes from `plink`, PuTTY's command-line connection tool, which does
the connecting behind every Plinky tab.*

<sub>Developers: see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).</sub>
