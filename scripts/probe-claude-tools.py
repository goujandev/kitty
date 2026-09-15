"""Records a Claude Code turn that uses tools and asks permission.

Adds `--permission-prompt-tool stdio`, which makes the CLI ask us before each
tool call instead of deciding on its own. Every request is approved, and the
whole exchange is recorded so the codec is written against observed traffic.

    python scripts/probe-claude-tools.py
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
FIXTURE = ROOT / "fixtures" / "claude" / "tools.jsonl"
TIMEOUT_S = 240

ARGS = [
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    # The whole point of this recording: make the CLI ask.
    "--permission-prompt-tool",
    "stdio",
]


def resolve_claude() -> list[str]:
    found = shutil.which("claude")
    if not found:
        raise SystemExit("claude is not on PATH")
    if found.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/C", found]
    return [found]


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else (
        "Read the file NOTICE-TEST.txt in this folder and tell me its contents. "
        "Do not do anything else."
    )

    # A file to read, so the turn definitely needs a tool.
    target = ROOT / "NOTICE-TEST.txt"
    target.write_text("kitty tool probe\n", encoding="utf-8")

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
    lock = threading.Lock()
    done = threading.Event()
    approvals = 0

    def send(obj: dict) -> None:
        raw = json.dumps(obj)
        with lock:
            recorded.append({"dir": "out", "raw": raw})
        assert proc.stdin is not None
        proc.stdin.write(raw + "\n")
        proc.stdin.flush()

    def pump() -> None:
        nonlocal approvals
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

            if msg.get("type") in ("control_request", "sdk_control_request"):
                request = msg.get("request") or {}
                if request.get("subtype") == "can_use_tool":
                    approvals += 1
                    print(f"  approving {request.get('tool_name')}")
                    send(
                        {
                            "type": "control_response",
                            "response": {
                                "subtype": "success",
                                "request_id": msg.get("request_id"),
                                "response": {
                                    "behavior": "allow",
                                    "updatedInput": request.get("input") or {},
                                },
                            },
                        }
                    )
            if msg.get("type") == "result":
                done.set()

    def errs() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            if line.strip():
                print(f"  [stderr] {line.rstrip()[:160]}")

    threading.Thread(target=pump, daemon=True).start()
    threading.Thread(target=errs, daemon=True).start()

    print(f"prompt: {prompt}")
    send(
        {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
        }
    )

    done.wait(TIMEOUT_S)
    time.sleep(0.4)
    proc.kill()
    target.unlink(missing_ok=True)

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    with FIXTURE.open("w", encoding="utf-8") as fh:
        with lock:
            for entry in recorded:
                fh.write(json.dumps(entry) + "\n")

    kinds: dict[str, int] = {}
    with lock:
        for entry in recorded:
            if entry["dir"] != "in":
                continue
            try:
                msg = json.loads(entry["raw"])
            except json.JSONDecodeError:
                continue
            kind = msg.get("type", "?")
            if kind == "stream_event":
                kind = f"stream_event/{(msg.get('event') or {}).get('type')}"
            elif kind in ("control_request", "sdk_control_request"):
                kind = f"{kind}/{(msg.get('request') or {}).get('subtype')}"
            kinds[kind] = kinds.get(kind, 0) + 1

    print(f"\nrecorded {len(recorded)} lines, approved {approvals} -> {FIXTURE.relative_to(ROOT)}")
    for k, n in sorted(kinds.items()):
        print(f"  {n:4d}  {k}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
