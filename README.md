# Plinky

**A desktop terminal and session manager built on PuTTY.**

Plinky is for system administrators, network engineers and anyone who works
over SSH, telnet or serial consoles. PuTTY's own tools make the connections
and transfer the files; Plinky adds tabs, split screens, a file browser, a
password vault and a few everyday time-savers.

It uses the sessions you have already saved in PuTTY, so there is nothing to
import. Sessions you add or change in Plinky are saved in the same place, so
PuTTY sees them too.

---

## What you can do with it

- **Open your PuTTY sessions in tabs.** The same saved sessions you use in
  PuTTY, organised in folders and subfolders, with tags and search.
- **Work side by side.** Split the window into two or four terminals, with a
  file browser next to your shell.
- **Type into several servers at once.** Group tabs into broadcast channels and
  send one command to all of them.
- **Move files without leaving the terminal.** A two-pane file browser for
  uploads, downloads and remote folders.
- **Keep passwords in an encrypted vault.** Log in automatically, including
  through a jump host, and send network devices their enable password when
  they ask for it. Passwords stay in the vault, not in PuTTY's session files.
- **Reach hosts behind a gateway.** Connect through a jump host / bastion with
  one setting.
- **Work with network gear.** Serial console sessions with USB adapter
  detection and Send Break, and slow line-by-line paste for devices that drop
  characters.
- **Use it as GNS3's console.** Set GNS3's custom console command to
  `plinky --telnet {host} {port} --title "{name}"` and every device opens as
  a tab in one Plinky window.
- **Save time.** Reusable command snippets with fill-in values, highlighted IPs
  and keywords, clickable links, and point-and-click cursor editing.
- **Keep a record.** Log any session straight to a file of your choice as it
  happens.
- **Manage tunnels and host keys** from one place.
- **Make it yours.** Ten interface themes (including a classic light look),
  seventeen terminal colour schemes, and programming fonts built in, so they
  work offline.

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

Plinky is free software under the [GNU General Public License v3.0](LICENSE)
(GPL-3.0-only). You may use, share and change it. If you distribute Plinky or
a modified version, you must do so under the same license, with its source
code.

For a commercial license, for example to use Plinky's code in a closed-source
product, contact the maintainer through GitHub.

Versions up to and including 0.1.4 were published under MIT or Apache-2.0;
copies of those versions keep those terms.

*The name comes from `plink`, PuTTY's command-line connection tool, which does
the connecting behind every Plinky tab.*

<sub>Developers: see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).</sub>
