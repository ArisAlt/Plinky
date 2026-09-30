"""Log in to every device in a list over SSH and change its configuration.

Run it on a terminal that is logged in to a jump device: a router, switch or
Linux server that can reach the others. For each address in ips.txt (next
to this script, one per line, # for comments) it types

    ssh -l USER <address>

answers the password prompt, applies CHANGES in configure terminal, saves,
types exit to come back to the jump device, and goes on to the next one.
A device that can't be reached or rejects a command is reported and
skipped; the rest carry on.

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
CHANGES = [
    "ntp server 192.0.2.123",
    "logging host 192.0.2.50",
]
DRY_RUN = True
SAVE = "write memory"

HERE = os.path.dirname(os.path.abspath(__file__))
IPS_FILE = os.path.join(HERE, "ips.txt")

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


def configure(address, device_prompt):
    """Applies CHANGES; returns True when every line was accepted."""
    prompt = r"(?m)^" + device_prompt
    session.command("terminal length 0", prompt=prompt)
    session.command("configure terminal", prompt=prompt)
    ok = True
    for line in CHANGES:
        reply = session.command(line, prompt=prompt)
        if "%" in reply:  # "% Invalid input detected", "% Incomplete command"
            session.log(f"{address}: rejected {line!r}: {reply.strip().splitlines()[-1]}")
            ok = False
            break
    session.command("end", prompt=prompt)
    if ok:
        session.command(SAVE, prompt=prompt, timeout=60)
    return ok


def main():
    addresses = read_addresses()
    if not addresses:
        session.log(f"No addresses in {IPS_FILE}")
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
            session.log(f"{address}: logged in; would apply {CHANGES} (DRY_RUN)")
            ok = True
        else:
            ok = configure(address, device_prompt)
            session.log(f"{address}: {'changed and saved' if ok else 'NOT changed'}")
        (done if ok else failed).append(address)
        session.send("exit")
        session.expect(home.pattern, timeout=15)

    session.log(f"Finished: {len(done)} ok, {len(failed)} failed" + (f": {', '.join(failed)}" if failed else ""))


main()
