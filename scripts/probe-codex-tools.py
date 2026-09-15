"""Records a Codex turn that uses tools and asks permission.

Runs the app-server with `approvalPolicy: "on-request"` and a read-only
sandbox, then asks for something that needs to escalate. Every request is
approved and the exchange is recorded.

    python scripts/probe-codex-tools.py
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "codex" / "tools.jsonl"
TIMEOUT_S = 240


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else (
        "Create a file called kitty-probe-scratch.txt containing the single word: ok. "
        "Then stop."
    )

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
    done = threading.Event()
    next_id = iter(range(1, 1000))
    approvals: list[str] = []

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

            method = msg.get("method")
            # A server-initiated request: it has both an id and a method.
            if method and msg.get("id") is not None:
                approvals.append(method)
                print(f"  approving {method}")
                if method == "item/permissions/requestApproval":
                    params = msg.get("params") or {}
                    send({"id": msg["id"], "result": {
                        "permissions": params.get("permissions") or {}}})
                else:
                    send({"id": msg["id"], "result": {"decision": "accept"}})
                continue

            if method == "turn/completed" or method == "error":
                done.set()

    def errs() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            if line.strip():
                print(f"  [stderr] {line.rstrip()[:160]}")

    threading.Thread(target=pump, daemon=True).start()
    threading.Thread(target=errs, daemon=True).start()

    def request(method: str, params: dict) -> dict:
        rid = next(next_id)
        send({"id": rid, "method": method, "params": params})
        deadline = time.time() + 40
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

    opened = request("thread/start", {
        "cwd": str(ROOT),
        # Read-only plus on-request is what forces an escalation.
        "sandbox": "read-only",
        "approvalPolicy": "on-request",
    })
    result = opened.get("result") or {}
    thread_id = (result.get("thread") or {}).get("id")
    print(f"thread {thread_id}")

    send({"id": next(next_id), "method": "turn/start", "params": {
        "threadId": thread_id,
        "input": [{"type": "text", "text": prompt}],
    }})

    done.wait(TIMEOUT_S)
    time.sleep(0.5)
    proc.kill()
    (ROOT / "kitty-probe-scratch.txt").unlink(missing_ok=True)

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    with FIXTURE.open("w", encoding="utf-8") as fh:
        with lock:
            for entry in recorded:
                fh.write(json.dumps(entry) + "\n")

    kinds: dict[str, int] = {}
    with lock:
        for msg in inbound:
            m = msg.get("method")
            if m:
                kinds[m] = kinds.get(m, 0) + 1

    print(f"\nrecorded {len(recorded)} lines, approved {len(approvals)} -> {FIXTURE.relative_to(ROOT)}")
    for k, n in sorted(kinds.items()):
        print(f"  {n:4d}  {k}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
