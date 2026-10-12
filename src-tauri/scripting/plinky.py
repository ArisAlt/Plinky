"""The helper's old name, from when Thyrion was called Plinky.

Scripts written for Plinky start with `from plinky import session`; they
keep working. New scripts: `from thyrion import session`. Both give the
same session object.
"""

from thyrion import *  # noqa: F401,F403
from thyrion import session, Session  # noqa: F401
