"""Ping a few addresses from the device and report which ones answer.

A small example of expect(): send a command, then wait for a line you know
the device prints, and read a value out of it. Run it from Plinky: right-click
the terminal of a logged-in router or Linux server, choose Run Script...,
pick this file.

Change TARGETS to your own addresses. PING is how the device pings: Cisco's
ping stops by itself after 5 packets; Linux's needs -c or it never stops.
"""

import re

from plinky import session

TARGETS = ["192.0.2.1", "192.0.2.2", "198.51.100.1"]
PING = "ping -c 5 {address}"   # Cisco IOS: "ping {address}"

# The line each system ends a ping with:
#   Cisco: "Success rate is 80 percent (4/5), ..."
#   Linux: "5 packets transmitted, 4 received, 20% packet loss, ..."
RESULT = r"Success rate is (\d+) percent|(\d+)% packet loss"

for address in TARGETS:
    session.send(PING.format(address=address))
    line = session.expect(RESULT, timeout=30)
    cisco, loss = re.search(RESULT, line).groups()
    rate = int(cisco) if cisco is not None else 100 - int(loss)
    session.log(f"{address:<16} {'OK  ' if rate > 0 else 'FAIL'} {rate}% answered")
