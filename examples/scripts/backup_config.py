"""Save a device's running configuration to a file.

Run it from Plinky: right-click the terminal of a router or switch that is
already logged in (at its > or # prompt), choose Run Script..., and pick
this file. It turns paging off, reads the running configuration and saves
it next to this script as <session>-<date>-<time>.cfg.

Written for Cisco IOS and IOS-XE. For other systems change the two
commands below (Juniper: "set cli screen-length 0" and
"show configuration"; Arista EOS works as it is).
"""

import datetime
import os
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


PAGING_OFF = "terminal length 0"
SHOW_CONFIG = "show running-config"

# The config is long and some devices are slow to print it.
TIMEOUT = 120


def safe_name(name):
    """A session name as a file name: "telnet://192.0.2.1:5000" -> "telnet-192.0.2.1-5000"."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "device"


def main():
    prompt = learn_prompt()
    session.command(PAGING_OFF, prompt=prompt)
    config = session.command(SHOW_CONFIG, prompt=prompt, timeout=TIMEOUT)

    if "Invalid input" in config or not config.strip():
        session.log("The device did not return a configuration:")
        session.log(config.strip()[:300] or "(nothing)")
        raise SystemExit(1)

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        f"{safe_name(session.name)}-{stamp}.cfg")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(config.strip() + "\n")

    lines = config.count("\n") + 1
    session.log(f"Saved {lines} lines to {path}")


main()
