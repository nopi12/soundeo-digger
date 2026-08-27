#!/usr/bin/env python3
import sqlite3
from pathlib import Path

# run inside container or with copied db — for remote use via ssh stdin
import sys
path = sys.argv[1] if len(sys.argv) > 1 else "/data/digger.db"
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
print("=== recent wants ===")
rows = conn.execute(
    """
    SELECT wd.user_id, wd.created_at, t.id as track_id, t.artist, t.title,
           t.duration_sec, t.bpm, t.label
    FROM want_downloads wd
    JOIN tracks t ON t.id = wd.track_id
    ORDER BY wd.created_at DESC
    LIMIT 25
    """
).fetchall()
for r in rows:
    refs = conn.execute(
        "SELECT platform, external_id FROM track_refs WHERE track_id = ?",
        (r["track_id"],),
    ).fetchall()
    ref_s = " | ".join(f"{x['platform']}:{x['external_id']}" for x in refs)
    print(
        f"{r['created_at']:.0f} {r['artist']} - {r['title']} "
        f"dur={r['duration_sec']} bpm={r['bpm']} :: {ref_s}"
    )
