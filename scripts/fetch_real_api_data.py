from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PROJECT = Path(__file__).resolve().parents[1]
CONFIG_FILE = PROJECT / "config" / "api_config.json"
CACHE_DIR = PROJECT / "data" / "api-cache"


def load_config():
    if not CONFIG_FILE.exists():
        raise SystemExit(
            "Missing config/api_config.json. Copy config/api_config.example.json "
            "to config/api_config.json and add your real API URLs/tokens."
        )
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def request_json(url, headers):
    request = Request(url, headers=headers or {})
    with urlopen(request, timeout=60) as response:
        content_type = response.headers.get("Content-Type", "")
        body = response.read().decode("utf-8")
        if "json" not in content_type.lower():
            raise ValueError(f"Expected JSON from {url}, got Content-Type: {content_type}")
        return json.loads(body)


def write_payload(system, name, payload):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = CACHE_DIR / f"{system}_{name}.json"
    target.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return target


def main():
    config = load_config()
    fetched = []

    for system, system_config in config.items():
        headers = system_config.get("headers", {})
        endpoints = system_config.get("endpoints", {})
        for name, url in endpoints.items():
            if not url or "your-" in url.lower() or "YOUR_" in json.dumps(headers):
                print(f"SKIP {system}.{name}: endpoint/token is not configured")
                continue
            try:
                payload = request_json(url, headers)
                target = write_payload(system, name, payload)
                fetched.append(str(target.relative_to(PROJECT)))
                print(f"OK {system}.{name} -> {target.relative_to(PROJECT)}")
            except HTTPError as exc:
                print(f"ERROR {system}.{name}: HTTP {exc.code} {exc.reason}")
            except URLError as exc:
                print(f"ERROR {system}.{name}: network error {exc.reason}")
            except Exception as exc:
                print(f"ERROR {system}.{name}: {exc}")

    if not fetched:
        raise SystemExit("No real API data fetched. Check config/api_config.json.")

    print("\nFetched real API data:")
    for item in fetched:
        print(f"- {item}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("Cancelled")
