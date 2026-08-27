#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

db = Path("/data/digger.db")
conn = sqlite3.connect(str(db))
conn.row_factory = sqlite3.Row

print("=== want_downloads count ===")
print(conn.execute("select count(*) as c from want_downloads").fetchone()["c"])

print("\n=== users ===")
for r in conn.execute("select id, created_at from users"):
    print(dict(r))

print("\n=== want rows matching NUAH/nuah ===")
q = """
SELECT wd.user_id, wd.created_at, t.id as track_id, t.artist, t.title,
       r.platform, r.external_id, r.raw_title, r.url
FROM want_downloads wd
JOIN tracks t ON t.id = wd.track_id
LEFT JOIN track_refs r ON r.track_id = t.id
WHERE lower(coalesce(t.artist,'')) LIKE '%nuah%'
   OR lower(coalesce(t.title,'')) LIKE '%nuah%'
   OR lower(coalesce(r.raw_title,'')) LIKE '%nuah%'
   OR lower(coalesce(r.url,'')) LIKE '%nuah%'
   OR lower(coalesce(r.external_id,'')) LIKE '%nuah%'
ORDER BY wd.created_at DESC
"""
rows = [dict(r) for r in conn.execute(q)]
print("matches", len(rows))
for r in rows[:80]:
    print(json.dumps(r, ensure_ascii=False))

print("\n=== all want_downloads ===")
q2 = """
SELECT wd.user_id,
       datetime(wd.created_at, 'unixepoch') as created,
       t.artist,
       t.title,
       group_concat(r.platform || ':' || r.external_id, ' | ') as refs
FROM want_downloads wd
JOIN tracks t ON t.id = wd.track_id
LEFT JOIN track_refs r ON r.track_id = t.id
GROUP BY wd.user_id, wd.track_id
ORDER BY wd.created_at DESC
LIMIT 100
"""
all_rows = [dict(r) for r in conn.execute(q2)]
print("rows", len(all_rows))
for r in all_rows:
    print(json.dumps(r, ensure_ascii=False))
