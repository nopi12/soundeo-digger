#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

# Run inside digger-api container
sys_path_ok = True
try:
    from app.match import parse_track_variants, pair_score, MATCH_THRESHOLD
except Exception as e:
    print("import fail", e)
    sys_path_ok = False

if sys_path_ok:
    a = parse_track_variants(
        raw_title="tipping point music - NUAH - Natural Behavior | PREMIERE",
        artist="tipping point music",
        title="NUAH - Natural Behavior | PREMIERE",
    )
    b = parse_track_variants(
        raw_title="NUAH - Natural Behaviour (Original Mix)",
        artist="NUAH",
        title="Natural Behaviour",
    )
    print("variant A0", a[0])
    print("variant B0", b[0])
    score = pair_score(a[0].artist_norm, a[0].title_norm, b[0].artist_norm, b[0].title_norm)
    print("score", score, "threshold", MATCH_THRESHOLD, "match", score >= MATCH_THRESHOLD)

conn = sqlite3.connect("/data/digger.db")
conn.row_factory = sqlite3.Row
print("\n=== NUAH wants after rematch ===")
q = """
SELECT wd.user_id, t.id, t.artist, t.title, t.artist_norm, t.title_norm,
       group_concat(r.platform || ':' || r.external_id, ' | ') as refs
FROM want_downloads wd
JOIN tracks t ON t.id = wd.track_id
LEFT JOIN track_refs r ON r.track_id = t.id
WHERE lower(t.artist) LIKE '%nuah%'
   OR lower(t.title) LIKE '%nuah%'
   OR lower(coalesce(r.external_id,'')) LIKE '%nuah%'
   OR lower(coalesce(r.raw_title,'')) LIKE '%nuah%'
GROUP BY wd.user_id, t.id
ORDER BY wd.created_at DESC
"""
for row in conn.execute(q):
    print(json.dumps(dict(row), ensure_ascii=False))
