#!/usr/bin/env python3
"""Fetch recent client logs from digger-api."""
import json
import sys
import urllib.request

BASE = "https://fervent-panini.93-90-203-17.plesk.page/digger-api"
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 30
level = sys.argv[2] if len(sys.argv) > 2 else ""

url = f"{BASE}/v1/admin/logs?limit={limit}"
if level:
    url += f"&level={level}"

with urllib.request.urlopen(url) as res:
    data = json.loads(res.read().decode())

print(f"count={data.get('count')}")
for row in data.get("logs") or []:
    print(
        f"{row.get('createdAt'):.0f} [{row.get('level')}] "
        f"{row.get('source')} {row.get('platform')} v{row.get('extVersion')}\n"
        f"  {row.get('message')}\n"
        f"  url={row.get('url')}\n"
        f"  ctx={json.dumps(row.get('context'), ensure_ascii=False)[:200]}"
    )
    print("---")
