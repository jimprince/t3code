#!/usr/bin/env python3
"""Host-local publication admission; remote immutable Git leases remain authoritative."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import uuid

MAX_AGE_SECONDS = 7200
SCHEMA = "t3code.active-publication/v1"


def read_marker(path: Path) -> dict | None:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024:
            raise ValueError(f"Invalid active publication marker file: {path}")
        with path.open(encoding="utf-8") as stream:
            value = json.load(stream)
    except FileNotFoundError:
        return None
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise ValueError(f"Invalid active publication marker: {path}")
    if not value.get("owner") or not value.get("token") or not isinstance(value.get("targetMain"), dict):
        raise ValueError("Invalid active publication owner or target")
    started = datetime.fromisoformat(value["startedAt"].replace("Z", "+00:00"))
    if started.tzinfo is None:
        raise ValueError("Active publication start time must have a timezone")
    age = (datetime.now(timezone.utc) - started).total_seconds()
    if age < -300:
        raise ValueError("Active publication start time is in the future")
    if age >= MAX_AGE_SECONDS:
        print(f"Ignoring stale active publication by {value.get('owner')} at {path} (over two hours old).", file=sys.stderr)
        return None
    return value


@contextmanager
def marker_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Never unlink the lock sidecar: all cooperating writers need the same inode.
    with os.fdopen(os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def main() -> None:
    action, raw_path, *args = sys.argv[1:]
    path = Path(raw_path)
    if not path.is_absolute():
        raise ValueError("Active publication marker path must be absolute")
    with marker_lock(path):
        if action == "release":
            # Cleanup only our own generation, including after expiry/replacement.
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return
            if value.get("token") == args[0]:
                path.unlink()
            return
        existing = read_marker(path)
        if existing:
            raise ValueError(f"Active publication by {existing['owner']} since {existing['startedAt']} targets {existing['targetMain']}; refusing another writer.")
        if action != "acquire":
            raise ValueError("Expected acquire or release")
        remote, oid, pid = args
        token = str(uuid.uuid4())
        value = {
            "schema": SCHEMA,
            "owner": os.environ.get("T3_THREAD_ID") or f"{socket.gethostname()}:{pid}",
            "token": token,
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "targetMain": {"remote": remote, "ref": "refs/heads/main", "oid": oid},
        }
        descriptor, temporary = tempfile.mkstemp(prefix=".publication-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(value, stream)
                stream.write("\n")
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print(token)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
