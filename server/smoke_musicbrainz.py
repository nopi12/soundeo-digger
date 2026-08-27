#!/usr/bin/env python3
import json
import urllib.request

BASE = "http://127.0.0.1:8010"


def post(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode())


print("=== verify NUAH ===")
print(
    json.dumps(
        post(
            "/v1/verify",
            {
                "artist": "NUAH",
                "title": "Natural Behavior",
                "rawTitle": "NUAH - Natural Behaviour (Original Mix)",
            },
        ),
        indent=2,
        ensure_ascii=False,
    )
)

print("\n=== verify premiere string ===")
print(
    json.dumps(
        post(
            "/v1/verify",
            {
                "artist": "tipping point music",
                "title": "NUAH - Natural Behavior | PREMIERE",
                "rawTitle": "tipping point music - NUAH - Natural Behavior | PREMIERE",
            },
        ),
        indent=2,
        ensure_ascii=False,
    )
)

print("\n=== verify known hit (sanity) ===")
print(
    json.dumps(
        post(
            "/v1/verify",
            {"artist": "Nirvana", "title": "Smells Like Teen Spirit"},
        ),
        indent=2,
        ensure_ascii=False,
    )
)

print("\n=== verify wants ===")
print(json.dumps(post("/v1/admin/verify-wants?limit=5"), indent=2, ensure_ascii=False))
