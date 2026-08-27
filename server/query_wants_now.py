#!/usr/bin/env python3
import json
import sqlite3

conn = sqlite3.connect("/data/digger.db")
conn.row_factory = sqlite3.Row

print("=== counts ===")
print("want_downloads", conn.execute("select count(*) c from want_downloads").fetchone()["c"])
print("tracks", conn.execute("select count(*) c from tracks").fetchone()["c"])
print("track_refs", conn.execute("select count(*) c from track_refs").fetchone()["c"])
print("users", conn.execute("select count(*) c from users").fetchone()["c"])

print("\n=== all want_downloads ===")
q = """
SELECT wd.user_id,
       datetime(wd.created_at, 'unixepoch') as created,
       t.artist, t.title, t.artist_norm, t.title_norm,
       group_concat(r.platform || ':' || r.external_id, ' | ') as refs
FROM want_downloads wd
JOIN tracks t ON t.id = wd.track_id
LEFT JOIN track_refs r ON r.track_id = t.id
GROUP BY wd.user_id, wd.track_id
ORDER BY wd.created_at DESC
"""
rows = [dict(r) for r in conn.execute(q)]
print("rows", len(rows))
for r in rows:
    print(json.dumps(r, ensure_ascii=False))
