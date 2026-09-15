"""Records what `codex app-server` reports for `model/list`.

    python scripts/probe-codex-models.py
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "codex" / "models.jsonl"


def main() -> int:
    proc = subprocess.Popen(
        ["codex", "app-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ROOT),
        text=True,
        encoding="utf-8",
        bufsize=1,
    )

    recorded: list[dict] = []
    inbound: list[dict] = []
    lock = threading.Lock()
    ids = iter(range(1, 100))

    def send(obj: dict) -> None:
        raw = json.dumps(obj)
        with lock:
            recorded.append({"dir": "out", "raw": raw})
        assert proc.stdin is not None
        proc.stdin.write(raw + "\n")
        proc.stdin.flush()

    def pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            with lock:
                recorded.append({"dir": "in", "raw": line})
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            with lock:
                inbound.append(msg)

    threading.Thread(target=pump, daemon=True).start()

    def request(method: str, params: dict) -> dict:
        rid = next(ids)
        send({"id": rid, "method": method, "params": params})
        deadline = time.time() + 30
        while time.time() < deadline:
            with lock:
                for msg in inbound:
                    if msg.get("id") == rid and ("result" in msg or "error" in msg):
                        return msg
            if proc.poll() is not None:
                raise SystemExit(f"codex exited early ({proc.returncode})")
            time.sleep(0.02)
        raise SystemExit(f"timed out waiting for {method}")

    request("initialize", {
        "clientInfo": {"name": "kitty", "title": "kitty", "version": "0.1.0"},
        "capabilities": {"experimentalApi": True},
    })
    send({"method": "initialized"})

    account = request("account/read", {})
    print("account:", json.dumps(account.get("result"))[:200])

    rows: list[dict] = []
    cursor = None
    while True:
        params = {"cursor": cursor} if cursor else {}
        page = request("model/list", params).get("result") or {}
        rows.extend(page.get("data") or [])
        cursor = page.get("nextCursor")
        if not cursor:
            break

    proc.kill()

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    with FIXTURE.open("w", encoding="utf-8") as fh:
        with lock:
            for entry in recorded:
                fh.write(json.dumps(entry) + "\n")

    print(f"\n{len(rows)} models -> {FIXTURE.relative_to(ROOT)}\n")
    for row in rows:
        native = row.get("model") or row.get("slug") or row.get("id")
        efforts = row.get("supportedReasoningEfforts")
        if efforts and isinstance(efforts[0], dict):
            efforts = [e.get("reasoningEffort") or e.get("id") for e in efforts]
        flags = []
        if row.get("isDefault"):
            flags.append("default")
        if row.get("hidden"):
            flags.append("hidden")
        print(f"  {str(native):26} {row.get('displayName') or row.get('name') or ''}")
        if efforts:
            print(f"      effort: {efforts}  default={row.get('defaultReasoningEffort')}")
        if flags:
            print(f"      {', '.join(flags)}")
    if rows:
        print("\nkeys on one model:", sorted(rows[0].keys()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
