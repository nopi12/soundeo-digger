#!/usr/bin/env python3
from pathlib import Path

path = Path("/etc/apache2/sites-enabled/ableton-collab.conf")
text = path.read_text()
snippet = (
    "    ProxyPass /digger-api/ http://127.0.0.1:8010/\n"
    "    ProxyPassReverse /digger-api/ http://127.0.0.1:8010/\n"
)
needle = "    ProxyPass / http://127.0.0.1:8001/"
if "ProxyPass /digger-api/" in text:
    print("proxy already present")
else:
    if needle not in text:
        raise SystemExit("needle not found")
    path.write_text(text.replace(needle, snippet + needle))
    print("proxy inserted")
