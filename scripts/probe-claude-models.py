"""Finds how Claude Code reports the models it can run.

There is no `models` subcommand and no listing flag, so it has to be a control
request over the stream protocol. This tries the plausible subtypes and records
whatever answers.

    python scripts/probe-claude-models.py
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "claude" / "models.jsonl"

CANDIDATES = [
    "initialize",
    "list_models",
    "models",
    "get_models",
    "supported_models",
    "model_list",
]

ARGS = [
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
]


def resolve_claude() -> list[str]:
    found = shutil.which("claude")
    if not found:
        raise SystemExit("claude is not on PATH")
    if found.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/C", found]
    return [found]


def main() -> int:
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
    answers: dict[str, dict] = {}
    lock = threading.Lock()

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
            if msg.get("type") == "control_response":
                rid = (msg.get("response") or {}).get("request_id", "")
                with lock:
                    answers[rid] = msg

    def errs() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            if line.strip():
                print(f"  [stderr] {line.rstrip()[:140]}")

    threading.Thread(target=pump, daemon=True).start()
    threading.Thread(target=errs, daemon=True).start()

    # Give the CLI a moment to announce itself.
    time.sleep(3)

    for index, subtype in enumerate(CANDIDATES):
        rid = f"probe-{index}"
        send({"type": "control_request", "request_id": rid, "request": {"subtype": subtype}})
        time.sleep(2.5)

    time.sleep(2)
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

    print(f"\nrecorded {len(recorded)} lines -> {FIXTURE.relative_to(ROOT)}\n")
    for index, subtype in enumerate(CANDIDATES):
        answer = answers.get(f"probe-{index}")
        if not answer:
            print(f"  {subtype:20} no reply")
            continue
        response = answer.get("response") or {}
        kind = response.get("subtype", "?")
        body = json.dumps(response.get("response", response))
        print(f"  {subtype:20} {kind}: {body[:400]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
