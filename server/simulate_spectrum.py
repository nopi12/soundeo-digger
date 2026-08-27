#!/usr/bin/env python3
"""Simulate bell-curve listen scoring from stored sessions."""

import importlib.util
import sys

spec = importlib.util.spec_from_file_location(
    "q", r"E:\Programmieren\Cursor\Soundeo Links\server\query_listen_sessions.py"
)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    data = q.load_blob(q.DEFAULT_BASE)
    sessions = q.extract_json_array(data, b"diggerListenSessions") or []
    print("spectrum simulation (prior sessions only):")
    for elapsed in [2, 3, 4, 5, 8, 12, 30, 92]:
        prior = [{"elapsedSec": s["elapsedSec"]} for s in sessions]
        # inline minimal JS-equivalent would need node; show concept from last 40 sessions
        samples = [
            float(s["elapsedSec"])
            for s in prior
            if float(s.get("elapsedSec") or 0) >= 2
        ][-300:]
        if len(samples) < 8:
            print(f"  {elapsed}s -> calibrating")
            continue
        avg = sum(samples) / len(samples)
        var = sum((x - avg) ** 2 for x in samples) / len(samples)
        sigma = max(var**0.5, 0.6)
        z = (elapsed - avg) / sigma
        print(
            f"  {elapsed:4.1f}s  μ={avg:.1f} σ={sigma:.1f}  z={z:+.2f}"
        )


if __name__ == "__main__":
    main()
