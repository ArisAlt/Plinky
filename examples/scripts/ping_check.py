"""Ping a few addresses from the device and report which ones answer.

A small example of expect(): send a command, then wait for a line you know
the device prints, and read a value out of it. Run it from Plinky: right-click
the terminal of a logged-in Cisco router, choose Run Script..., pick this file.

Change TARGETS to your own addresses.
"""

from plinky import session

TARGETS = ["192.0.2.1", "192.0.2.2", "198.51.100.1"]

for address in TARGETS:
    session.send(f"ping {address}")
    # IOS ends every ping with: "Success rate is 80 percent (4/5), ..."
    line = session.expect(r"Success rate is (\d+) percent", timeout=30)
    rate = int(line.rsplit("Success rate is ", 1)[1].split()[0])
    session.log(f"{address:<16} {'OK  ' if rate > 0 else 'FAIL'} {rate}% answered")
