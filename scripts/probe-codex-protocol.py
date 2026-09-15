"""One-off protocol proof for the Codex app-server.

Drives `codex app-server` by hand to confirm the handshake and the streaming
shapes before any Rust is written against them. Records every line exchanged to
a fixture file.

This is scaffolding, not product code. The real recorder is a Rust tool built
with the supervisor; this exists so the codec is written against observed
traffic rather than against a guess.

    python scripts/probe-codex-protocol.py "Say hello in exactly three words."
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "codex" / "hello.jsonl"
TIMEOUT_S = 120


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else "Say hello in exactly three words."

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
    lock = threading.Lock()
    inbound: list[dict] = []
    done = threading.Event()

    def pump_stdout() -> None:
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
                print(f"  [non-json] {line[:120]}")
                continue
            with lock:
                inbound.append(msg)
            method = msg.get("method")
            if method == "turn/completed":
                done.set()
            if method == "error" or "error" in msg:
                done.set()

    def pump_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            if line.strip():
                print(f"  [stderr] {line.rstrip()[:160]}")

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()

    next_id = iter(range(1, 1000))

    def send(obj: dict) -> None:
        raw = json.dumps(obj)
        with lock:
            recorded.append({"dir": "out", "raw": raw})
        assert proc.stdin is not None
        proc.stdin.write(raw + "\n")
        proc.stdin.flush()

    def request(method: str, params: dict) -> dict:
        rid = next(next_id)
        send({"id": rid, "method": method, "params": params})
        deadline = time.time() + 30
        while time.time() < deadline:
            with lock:
                for msg in inbound:
                    if msg.get("id") == rid and ("result" in msg or "error" in msg):
                        return msg
            if proc.poll() is not None:
                raise SystemExit(f"codex exited early with code {proc.returncode}")
            time.sleep(0.02)
        raise SystemExit(f"timed out waiting for a reply to {method}")

    print("initialize")
    init = request(
        "initialize",
        {
            "clientInfo": {"name": "kitty", "title": "kitty", "version": "0.1.0"},
            "capabilities": {"experimentalApi": True},
        },
    )
    print(f"  -> keys {sorted((init.get('result') or {}).keys())}")

    send({"method": "initialized"})

    print("thread/start")
    thread = request(
        "thread/start",
        {"cwd": str(ROOT), "sandbox": "read-only", "approvalPolicy": "never"},
    )
    result = thread.get("result") or {}
    thread_id = (result.get("thread") or {}).get("id") or result.get("threadId")
    print(f"  -> threadId {thread_id}")
    if not thread_id:
        print(f"  !! could not find a thread id in {json.dumps(result)[:400]}")
        proc.kill()
        return 1

    print(f"turn/start  {prompt!r}")
    send(
        {
            "id": next(next_id),
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt}],
            },
        }
    )

    done.wait(TIMEOUT_S)
    time.sleep(0.4)
    proc.kill()

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    with FIXTURE.open("w", encoding="utf-8") as fh:
        with lock:
            for entry in recorded:
                fh.write(json.dumps(entry) + "\n")

    with lock:
        methods: dict[str, int] = {}
        text = []
        for msg in inbound:
            m = msg.get("method")
            if m:
                methods[m] = methods.get(m, 0) + 1
            if m == "item/agentMessage/delta":
                params = msg.get("params") or {}
                text.append(params.get("delta") or params.get("text") or "")

    print(f"\nrecorded {len(recorded)} lines -> {FIXTURE.relative_to(ROOT)}")
    print("\nnotification methods seen:")
    for m, n in sorted(methods.items()):
        print(f"  {n:4d}  {m}")
    if text:
        print(f"\nassembled text: {''.join(text)!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
