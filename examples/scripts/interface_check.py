"""Report interfaces that are down or counting input errors.

Run it from Plinky: right-click the terminal of a router or switch that is
already logged in, choose Run Script..., and pick this file. It changes
nothing on the device; it only runs show commands and writes a short
report in the terminal (the [script] lines).

Written for Cisco IOS and IOS-XE.
"""

import re

from plinky import session


def learn_prompt():
    """The device's own prompt ("R1#"), as a pattern for the end of output.

    The default pattern takes any line ending in # or > for the prompt, and
    configs have such lines ("banner motd #", a description ending in ">"):
    output would be cut there.
    """
    # Enter first: wakes a console that prints nothing until pressed.
    session.send("")
    seen = session.wait_for_prompt()
    prompt = seen.replace("\r", "\n").split("\n")[-1].strip()
    return r"^" + re.escape(prompt) + r"\s*$"


# Interfaces an administrator shut down on purpose are listed apart from
# ones that are down on their own.
BRIEF = "show ip interface brief"
COUNTERS = "show interfaces | include ^[A-Za-z]|input errors"


def parse_brief(text):
    """Rows of "show ip interface brief": name, address, status, protocol.

    Interface   IP-Address  OK? Method Status                Protocol
    Gi0/0       192.0.2.1   YES manual up                    up
    Gi0/1       unassigned  YES unset  administratively down down
    """
    rows = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 6 or parts[0] == "Interface":
            continue
        name, address = parts[0], parts[1]
        protocol = parts[-1]
        status = " ".join(parts[4:-1])
        rows.append((name, address, status, protocol))
    return rows


def parse_input_errors(text):
    """{interface: input errors} from "show interfaces"."""
    errors = {}
    current = None
    for line in text.splitlines():
        header = re.match(r"^(\S+) is ", line)
        if header:
            current = header.group(1)
            continue
        count = re.search(r"(\d+) input errors", line)
        if current and count:
            errors[current] = int(count.group(1))
    return errors


def main():
    prompt = learn_prompt()
    session.command("terminal length 0", prompt=prompt)

    rows = parse_brief(session.command(BRIEF, prompt=prompt))
    if not rows:
        session.log("No interfaces found: is this a Cisco IOS device, logged in?")
        raise SystemExit(1)

    shut = [r for r in rows if r[2].startswith("administratively")]
    down = [r for r in rows if r not in shut and (r[2] != "up" or r[3] != "up")]
    errors = {k: v for k, v in parse_input_errors(session.command(COUNTERS, prompt=prompt)).items() if v > 0}

    session.log(f"{len(rows)} interfaces: {len(rows) - len(down) - len(shut)} up, "
                f"{len(down)} down, {len(shut)} shut down by an administrator")
    for name, address, status, protocol in down:
        session.log(f"  DOWN   {name:<24} {address:<16} status {status}, protocol {protocol}")
    for name, count in sorted(errors.items(), key=lambda e: -e[1]):
        session.log(f"  ERRORS {name:<24} {count} input errors")
    if not down and not errors:
        session.log("  Nothing to report.")


main()
