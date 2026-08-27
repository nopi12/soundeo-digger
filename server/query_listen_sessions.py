#!/usr/bin/env python3
"""Read diggerListenSessions from Chrome extension local storage (LevelDB blobs)."""
import json
import os
import statistics
import sys
from collections import Counter

EXT_ID = "imggifmendpgflpnagcpiepammemgdkg"
STORAGE_KEY = "diggerListenSessions"

DEFAULT_BASE = os.path.join(
    os.environ.get("LOCALAPPDATA", ""),
    "Google",
    "Chrome",
    "User Data",
    "Default",
    "Local Extension Settings",
    EXT_ID,
)


def load_blob(base: str) -> bytes:
    data = b""
    for name in os.listdir(base):
        path = os.path.join(base, name)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "rb") as handle:
                data += handle.read()
        except OSError:
            pass
    return data


def extract_json_array(data: bytes, key: bytes):
    idx = data.rfind(key)
    if idx < 0:
        return None
    chunk = data[idx : idx + 500000]
    start = chunk.find(b"[")
    if start < 0:
        return None
    depth = 0
    end = start
    for pos in range(start, len(chunk)):
        ch = chunk[pos : pos + 1]
        if ch in (b"{", b"["):
            depth += 1
        elif ch in (b"}", b"]"):
            depth -= 1
            if depth == 0:
                end = pos + 1
                break
    return json.loads(chunk[start:end].decode("utf-8", "replace"))


def percentile(values, p):
    if not values:
        return None
    sorted_vals = sorted(values)
    idx = int((len(sorted_vals) - 1) * p)
    return sorted_vals[idx]


def summarize(sessions):
    if not sessions:
        print("No listen sessions found.")
        return

    outcomes = Counter((s.get("outcome") or "empty") for s in sessions)
    platforms = Counter(s.get("platform") for s in sessions)
    reasons = Counter(s.get("endReason") for s in sessions)

    elapsed = [
        float(s["elapsedSec"])
        for s in sessions
        if float(s.get("elapsedSec") or 0) >= 2
        and s.get("endReason") in ("switch", "stop")
    ]
    pcts = [
        float(s["pct"])
        for s in sessions
        if s.get("pct") is not None and 0 < float(s["pct"]) <= 1
    ]

    skip_elapsed = percentile(elapsed, 0.35) or 12
    listen_elapsed = percentile(elapsed, 0.72) or 45
    listen_pct = percentile(pcts, 0.62) or 0.32
    skip_pct = percentile(pcts, 0.22) or 0.1

    print(f"sessions={len(sessions)}")
    print(f"outcomes={dict(outcomes)}")
    print(f"platforms={dict(platforms)}")
    print(f"endReason={dict(reasons)}")
    print(
        "profile "
        f"skip≤{skip_elapsed:.0f}s / {skip_pct*100:.0f}% · "
        f"listen≥{listen_elapsed:.0f}s / {listen_pct*100:.0f}%"
    )
    if elapsed:
        print(
            f"elapsed median={statistics.median(elapsed):.1f}s "
            f"min={min(elapsed):.1f}s max={max(elapsed):.1f}s n={len(elapsed)}"
        )
    if pcts:
        print(
            f"pct median={statistics.median(pcts)*100:.0f}% "
            f"min={min(pcts)*100:.0f}% max={max(pcts)*100:.0f}% n={len(pcts)}"
        )

    print("\nrecent:")
    for s in sessions[-20:]:
        title = (s.get("title") or s.get("key") or "")[:45]
        artist = (s.get("artist") or "")[:28]
        pct = s.get("pct")
        pct_s = f"{float(pct)*100:.0f}%" if pct is not None else "—"
        print(
            f"  {s.get('outcome') or '?':7} "
            f"{float(s.get('elapsedSec') or 0):6.1f}s "
            f"pct={pct_s:>4} "
            f"{s.get('platform') or '':10} "
            f"{artist} — {title} "
            f"[{s.get('endReason')}]"
        )


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE
    if not os.path.isdir(base):
        print(f"Storage dir not found: {base}", file=sys.stderr)
        sys.exit(1)
    data = load_blob(base)
    sessions = extract_json_array(data, STORAGE_KEY.encode())
    summarize(sessions or [])


if __name__ == "__main__":
    main()
