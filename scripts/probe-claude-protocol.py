"""One-off protocol proof for Claude Code's stream-json mode.

Same purpose as the Codex probe: confirm the handshake and streaming shapes
against the installed CLI before writing a codec, and record the traffic.

    python scripts/probe-claude-protocol.py "Say hello in exactly three words."
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "claude" / "hello.jsonl"
TIMEOUT_S = 180

ARGS = [
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
]


def resolve_claude() -> list[str]:
    """`claude` is an npm shim on Windows; a .cmd needs cmd.exe to launch."""
    found = shutil.which("claude")
    if not found:
        raise SystemExit("claude is not on PATH")
    if found.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/C", found]
    return [found]


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else "Say hello in exactly three words."

    proc = subprocess.Popen(
        resolve_claude() + ARGS,
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
                print(f"  [non-json] {line[:140]}")
                continue
            with lock:
                inbound.append(msg)
            if msg.get("type") == "result":
                done.set()

    def pump_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            if line.strip():
                print(f"  [stderr] {line.rstrip()[:160]}")

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()

    def send(obj: dict) -> None:
        raw = json.dumps(obj)
        with lock:
            recorded.append({"dir": "out", "raw": raw})
        assert proc.stdin is not None
        proc.stdin.write(raw + "\n")
        proc.stdin.flush()

    print(f"sending user turn {prompt!r}")
    send(
        {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
        }
    )

    done.wait(TIMEOUT_S)
    time.sleep(0.3)
    try:
        if proc.stdin:
            proc.stdin.close()
    except OSError:
        pass
    proc.kill()

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    with FIXTURE.open("w", encoding="utf-8") as fh:
        with lock:
            for entry in recorded:
                fh.write(json.dumps(entry) + "\n")

    with lock:
        kinds: dict[str, int] = {}
        text_parts: list[str] = []
        for msg in inbound:
            kind = msg.get("type", "?")
            if kind == "stream_event":
                ev = (msg.get("event") or {}).get("type", "?")
                kind = f"stream_event/{ev}"
                delta = (msg.get("event") or {}).get("delta") or {}
                if delta.get("type") == "text_delta":
                    text_parts.append(delta.get("text", ""))
            kinds[kind] = kinds.get(kind, 0) + 1

    print(f"\nrecorded {len(recorded)} lines -> {FIXTURE.relative_to(ROOT)}")
    print("\nmessage kinds seen:")
    for k, n in sorted(kinds.items()):
        print(f"  {n:4d}  {k}")
    if text_parts:
        print(f"\nassembled text: {''.join(text_parts)!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
