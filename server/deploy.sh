#!/usr/bin/env bash
# Deploy digger listen API on this host (run as root on the server).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET=/opt/digger-api

mkdir -p "$TARGET"
rsync -a --delete \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "$ROOT/" "$TARGET/"

cd "$TARGET"
docker compose up -d --build

CONF=/etc/apache2/sites-enabled/ableton-collab.conf
MARKER="ProxyPass /digger-api/"
if [[ -f "$CONF" ]] && ! grep -qF "$MARKER" "$CONF"; then
  python3 - <<'PY'
from pathlib import Path
path = Path("/etc/apache2/sites-enabled/ableton-collab.conf")
text = path.read_text()
snippet = (
    "    ProxyPass /digger-api/ http://127.0.0.1:8010/\n"
    "    ProxyPassReverse /digger-api/ http://127.0.0.1:8010/\n"
)
needle = "    ProxyPass / http://127.0.0.1:8001/"
if snippet.strip() in text:
    raise SystemExit(0)
if needle not in text:
    raise SystemExit("ProxyPass target not found in ableton-collab.conf")
text = text.replace(needle, snippet + needle)
path.write_text(text)
print("apache digger-api proxy inserted")
PY
  apachectl configtest
  systemctl reload apache2
fi

echo "health:"
curl -fsS http://127.0.0.1:8010/health
echo
curl -fsS https://fervent-panini.93-90-203-17.plesk.page/digger-api/health || true
echo
echo "deployed"
