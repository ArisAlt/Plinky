"""Log in to every device in a list over SSH and change its configuration.

Run it on a terminal that is logged in to a jump device: a router, switch or
Linux server that can reach the others. For each address in ips.txt (next
to this script, one per line, # for comments) it types

    ssh -l USER <address>

answers the password prompt, types the lines of commands.txt one by one
(waiting for the prompt after each), types exit to come back to the jump
device, and goes on to the next one. commands.txt holds the commands
exactly as you would type them, configure terminal, end and write memory
included; empty lines and lines starting with ! are skipped. A device
that can't be reached or rejects a command is reported and skipped; the
rest carry on.

The password is asked for once, in a small window (Python's tkinter), or
read from the PLINKY_DEVICE_PASSWORD environment variable. It is never
written anywhere. Scripts can't read Plinky's vault.

Starts in DRY_RUN: it logs in and shows what it would change, and changes
nothing. Try it on one address first, then set DRY_RUN = False.
Written for Cisco IOS and IOS-XE devices.
"""

import os
import re

from plinky import session

USER = "admin"
DRY_RUN = True

HERE = os.path.dirname(os.path.abspath(__file__))
IPS_FILE = os.path.join(HERE, "ips.txt")
COMMANDS_FILE = os.path.join(HERE, "commands.txt")

# A command that asks a question ("Destination filename [startup-config]?"
# from copy running-config startup-config) waits for this long, then fails:
# use write memory, or answer it with its own line in the file.
COMMAND_TIMEOUT = 60

# What can come back after "ssh -l": each alternative is a named group, and
# expect() stops at whichever shows first.
LOGIN = re.compile(
    r"(?P<password>[Pp]assword:\s*$)"
    r"|(?P<hostkey>\(yes/no[^)]*\)\??\s*$)"
    r"|(?P<failed>% ?Connection refused|timed out|[Uu]nreachable|No route to host"
    r"|% ?Authentication failed|Permission denied|Connection closed)"
    r"|(?P<prompt>^[\w.\-()/]+[>#]\s?$)",
    re.MULTILINE,
)


def ask_password():
    password = os.environ.get("PLINKY_DEVICE_PASSWORD")
    if password:
        return password
    try:
        import tkinter
        from tkinter import simpledialog
    except ImportError:
        session.log("No password: set PLINKY_DEVICE_PASSWORD, or install Python's tkinter.")
        raise SystemExit(1)
    root = tkinter.Tk()
    root.withdraw()
    password = simpledialog.askstring("Device password", f"Password for {USER}:", show="*", parent=root)
    root.destroy()
    if not password:
        session.log("No password given; nothing done.")
        raise SystemExit(1)
    return password


def read_commands():
    with open(COMMANDS_FILE, encoding="utf-8") as f:
        lines = [line.rstrip("\r\n") for line in f]
    return [line for line in lines if line.strip() and not line.lstrip().startswith("!")]


def read_addresses():
    with open(IPS_FILE, encoding="utf-8") as f:
        return [line.split("#")[0].strip() for line in f if line.split("#")[0].strip()]


def learn_prompt():
    """The jump device's own prompt, to know when we are back on it."""
    session.send("")
    seen = session.wait_for_prompt()
    prompt = seen.replace("\r", "\n").split("\n")[-1].strip()
    return re.compile(r"^" + re.escape(prompt) + r"\s*$", re.MULTILINE)


def wait(pattern, timeout=20):
    """expect() on a compiled pattern; returns (which group matched, text)."""
    seen = session.expect(pattern.pattern, timeout=timeout)
    match = re.compile(pattern.pattern, pattern.flags).search(seen)
    kind = next((name for name, value in match.groupdict().items() if value), None) if match.groupdict() else None
    return kind, seen


def log_in(address, password, home):
    """Returns the device's prompt pattern, or None if the login failed."""
    # Drop whatever is left from the last device (an extra prompt after a
    # failed login), or it would be read as this one's answer.
    session.read(quiet=0.3)
    session.send(f"ssh -l {USER} {address}")
    sent_password = False
    while True:
        kind, seen = wait(LOGIN, timeout=30)
        if kind == "hostkey":
            session.send("yes")
        elif kind == "password":
            if sent_password:
                session.log(f"{address}: password rejected")
                session.send("\x03", enter=False)  # Ctrl+C out of the prompt
                return None
            session.send(password)
            sent_password = True
        elif kind == "failed":
            session.log(f"{address}: could not log in ({seen.strip().splitlines()[-1]})")
            return None
        elif kind == "prompt":
            prompt = seen.replace("\r", "\n").split("\n")[-1].strip()
            if home.search(prompt):
                # Back on the jump device: ssh gave up without a message
                # this script knows. Never configure the jump device.
                session.log(f"{address}: could not log in ({seen.strip().splitlines()[0]})")
                return None
            if prompt.endswith(">"):
                session.send("enable")
                kind, _ = wait(LOGIN)
                if kind == "password":
                    session.send(password)
                    kind, seen = wait(LOGIN)
                prompt = seen.replace("\r", "\n").split("\n")[-1].strip()
                if not prompt.endswith("#"):
                    session.log(f"{address}: enable failed")
                    return None
            return re.escape(prompt[:-1]) + r"(\([\w\-]+\))?#\s*$"


def configure(address, device_prompt, commands):
    """Types each command, waiting for the prompt after it. Stops at the
    first one the device rejects; returns True when every one was accepted.
    """
    prompt = r"(?m)^" + device_prompt
    for line in commands:
        reply = session.command(line, prompt=prompt, timeout=COMMAND_TIMEOUT)
        # IOS errors start "% " ("% Invalid input detected", "% Incomplete
        # command"); console messages like "%SYS-5-CONFIG_I" have no space.
        error = next((l.strip() for l in reply.splitlines() if l.lstrip().startswith("% ")), None)
        if error:
            session.log(f"{address}: rejected {line!r}: {error}")
            # Leave configuration mode, whatever mode the file had reached.
            session.command("end", prompt=prompt)
            return False
    return True


def main():
    addresses = read_addresses()
    if not addresses:
        session.log(f"No addresses in {IPS_FILE}")
        raise SystemExit(1)
    commands = read_commands()
    if not commands:
        session.log(f"No commands in {COMMANDS_FILE}")
        raise SystemExit(1)
    home = learn_prompt()
    password = ask_password()
    done, failed = [], []

    for address in addresses:
        device_prompt = log_in(address, password, home)
        if device_prompt is None:
            failed.append(address)
            session.send("")
            session.expect(home.pattern, timeout=15)
            continue
        if DRY_RUN:
            session.log(f"{address}: logged in; would type {len(commands)} lines from commands.txt (DRY_RUN)")
            ok = True
        else:
            ok = configure(address, device_prompt, commands)
            session.log(f"{address}: {'all commands accepted' if ok else 'stopped at an error'}")
        (done if ok else failed).append(address)
        session.send("exit")
        session.expect(home.pattern, timeout=15)

    session.log(f"Finished: {len(done)} ok, {len(failed)} failed" + (f": {', '.join(failed)}" if failed else ""))


main()
