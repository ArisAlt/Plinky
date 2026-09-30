"""Helper for scripts run from Plinky (right-click a terminal, Run Script).

Plinky connects the script to one session: what the script prints goes to
the device, what the device prints comes in on the script's input, and what
the script writes to stderr shows in the terminal as a note. This module
wraps that in a few calls:

    from plinky import session

    session.send("terminal length 0")
    session.wait_for_prompt()
    config = session.command("show running-config")
    session.log(f"got {len(config)} characters")

Plinky puts this file on the script's PYTHONPATH; nothing to install.
"""

import os
import re
import sys
import threading
import time

__all__ = ["session", "Session"]

# A prompt at the end of the output: "R1#", "R1>", "user@host:~$ ",
# "[admin@fw] >", "% ".
DEFAULT_PROMPT = r"[>#$%]\s?$"


class Session:
    def __init__(self):
        self.name = os.environ.get("PLINKY_SESSION", "")
        self._buf = ""
        self._cond = threading.Condition()
        self._closed = False
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        # The raw descriptor, not sys.stdin: a thread blocked inside the
        # buffered reader holds its lock, and Python then dies at exit with
        # "could not acquire lock for <stdin>".
        fd = sys.stdin.fileno()
        while True:
            try:
                data = os.read(fd, 4096)
            except (OSError, ValueError):
                data = b""
            with self._cond:
                if not data:
                    self._closed = True
                    self._cond.notify_all()
                    return
                self._buf += data.decode("utf-8", errors="replace")
                self._cond.notify_all()

    def send(self, text, enter=True):
        """Types `text` into the session, then Enter unless enter=False."""
        data = text + ("\r" if enter else "")
        sys.stdout.buffer.write(data.encode("utf-8"))
        sys.stdout.buffer.flush()

    def expect(self, pattern, timeout=30):
        """Waits until `pattern` (a regular expression) shows in the output.

        Returns everything up to and including the match, and forgets it, so
        the next expect() looks only at what came after. Raises TimeoutError
        after `timeout` seconds, with what did arrive in the message.
        """
        rx = re.compile(pattern, re.MULTILINE)
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                m = rx.search(self._buf)
                if m:
                    seen, self._buf = self._buf[: m.end()], self._buf[m.end():]
                    return seen
                left = deadline - time.monotonic()
                if left <= 0 or self._closed:
                    tail = self._buf[-200:]
                    raise TimeoutError(f"no {pattern!r} after {timeout} s; last output: {tail!r}")
                self._cond.wait(left)

    def wait_for_prompt(self, prompt=DEFAULT_PROMPT, timeout=30):
        """Waits for the device's prompt and returns what came before it."""
        return self.expect(prompt, timeout)

    def read(self, quiet=0.5, timeout=30):
        """Returns output once none has arrived for `quiet` seconds."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while time.monotonic() < deadline:
                size = len(self._buf)
                self._cond.wait(quiet)
                if len(self._buf) == size or self._closed:
                    break
            out, self._buf = self._buf, ""
            return out

    def command(self, cmd, prompt=DEFAULT_PROMPT, timeout=60):
        """Runs `cmd` and returns its output: no echoed command, no prompt."""
        with self._cond:
            self._buf = ""
        self.send(cmd)
        seen = self.expect(prompt, timeout)
        lines = seen.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if lines and cmd.strip() and cmd.strip() in lines[0]:
            lines = lines[1:]
        if lines:
            lines = lines[:-1]  # the prompt
        return "\n".join(lines)

    def log(self, *parts):
        """Shows a note in the terminal. It is not sent to the device."""
        print(*parts, file=sys.stderr, flush=True)


session = Session()
