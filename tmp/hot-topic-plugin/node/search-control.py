"""Local, non-secret progress handshake with the plugin's ranking worker."""
import asyncio
import os
from pathlib import Path

_sequence = 0


def phase():
    return os.environ.get("CINDY_SEARCH_PHASE", "collect")


def status(value):
    Path(os.environ["CINDY_SEARCH_STATUS"]).write_text(value, encoding="utf-8")


async def checkpoint():
    global _sequence
    root = Path(os.environ["CINDY_SEARCH_CONTROL"])
    _sequence += 1
    pending = root / "ready.tmp"
    pending.write_text(str(_sequence), encoding="utf-8")
    pending.replace(root / "ready")
    for _ in range(300):
        try:
            decision = (root / "decision").read_text(encoding="utf-8")
        except FileNotFoundError:
            decision = ""
        if decision == str(_sequence) + ":stop":
            return True
        if decision == str(_sequence) + ":continue":
            return False
        await asyncio.sleep(0.1)
    raise RuntimeError("Ranking worker stopped responding")
