"""Exercise the Linux updater with cron's environment and a disposable release."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("headless-auto-upgrade.sh")
VERSION = "0.0.39-nightly.20260906.1293-fork.2"


def seed_idle(path):
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE projection_thread_sessions (thread_id TEXT, status TEXT, active_turn_id TEXT);
            CREATE TABLE provider_session_runtime (thread_id TEXT, status TEXT, active_turn_id TEXT);
            CREATE TABLE projection_turns (thread_id TEXT, turn_id TEXT, state TEXT, checkpoint_status TEXT);
            CREATE TABLE projection_threads (thread_id TEXT, latest_turn_id TEXT, pending_user_input_count INTEGER);
            CREATE TABLE projection_pending_approvals (thread_id TEXT, status TEXT);
            INSERT INTO projection_threads VALUES ('thread', 'turn', 0);
            INSERT INTO projection_turns VALUES ('thread', 'turn', 'completed', NULL);
        """)


class ActivityGuardTest(unittest.TestCase):
    def check(self, home, *args):
        return subprocess.run(['/bin/bash', str(SCRIPT), *args], text=True,
            capture_output=True, timeout=10, env={**os.environ, 'HOME': str(home),
                'T3CODE_HEADLESS_STATE_DB': str(home / 'state.sqlite'),
                'T3CODE_HEADLESS_QUEUE_STATE': str(home / 'queue.json')})

    def test_completed_and_idle_threads_allow_update(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            seed_idle(home / 'state.sqlite')
            self.assertEqual(self.check(home, '--check-idle').returncode, 0)

    def test_active_work_blocks_update_without_changing_install(self):
        cases = [
            "INSERT INTO projection_thread_sessions VALUES ('thread', 'running', 'turn')",
            "INSERT INTO projection_thread_sessions VALUES ('thread', 'starting', NULL)",
            "INSERT INTO provider_session_runtime VALUES ('thread', 'running', 'pending:send')",
            "UPDATE projection_turns SET state = 'pending'",
            "UPDATE projection_turns SET checkpoint_status = 'pending'",
            "INSERT INTO projection_pending_approvals VALUES ('thread', 'pending')",
            "UPDATE projection_threads SET pending_user_input_count = 1",
        ]
        for query in cases:
            with self.subTest(query=query), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                seed_idle(home / 'state.sqlite')
                with sqlite3.connect(home / 'state.sqlite') as db:
                    db.execute(query)
                self.assertEqual(self.check(home, '--check-idle').returncode, 75)
                result = self.check(home)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('update deferred until threads finish', result.stderr)
                self.assertFalse((home / '.local/share/t3code-server/current').exists())

    def test_queued_followup_prevents_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            seed_idle(home / 'state.sqlite')
            (home / 'queue.json').write_text(json.dumps({'queuedSends': [{'threadId': 'queued', 'status': 'queued'}]}))
            self.assertEqual(self.check(home, '--check-idle').returncode, 75)

    def test_unreadable_or_unknown_state_never_means_idle(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            result = self.check(home)
            self.assertEqual(result.returncode, 1)
            self.assertIn('activity could not be checked', result.stderr)
            self.assertFalse((home / 'state.sqlite').exists())
            (home / 'state.sqlite').write_text('broken')
            self.assertEqual(self.check(home, '--check-idle').returncode, 1)


@unittest.skipUnless(sys.platform == "linux", "Linux release installer")
class CronUpgradeTest(unittest.TestCase):
    def test_cron_installs_release_using_user_local_node(self):
        self.run_upgrade("idle")

    def test_work_started_during_download_defers_without_changing_current(self):
        self.run_upgrade("busy-during-download")

    def test_only_explicit_force_can_upgrade_while_busy(self):
        self.run_upgrade("force")

    def run_upgrade(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            seed_idle(home / "state.sqlite")
            if mode == "force":
                with sqlite3.connect(home / "state.sqlite") as db:
                    db.execute("UPDATE projection_turns SET state='running'")
            commands = home / "commands"
            commands.mkdir()
            # Deliberately expose system utilities without any system Node.
            for name in ("bash", "python3", "mktemp", "rm", "mkdir", "tar", "mv",
                         "ln", "readlink", "find", "sort", "awk", "seq", "gzip", "flock"):
                (commands / name).symlink_to(shutil.which(name))
            node = home / ".local/node/bin/node"
            node.parent.mkdir(parents=True)
            node.write_text(f'#!/bin/sh\necho "T3 Code {VERSION}"\n')
            node.chmod(0o755)
            release = home / "artifact/bin"
            release.mkdir(parents=True)
            launcher = release / "t3"
            launcher.write_text('#!/bin/sh\nexec node "$@"\n')
            launcher.chmod(0o755)
            archive = home / "release.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(release.parent, arcname="headless")
            metadata = home / "release.json"
            metadata.write_text(json.dumps([{
                "tag_name": "v" + VERSION, "prerelease": True,
                "assets": [{"name": f"t3-headless-{VERSION}-linux-x64.tar.gz",
                            "browser_download_url": "https://fixture.invalid/artifact"}],
            }]))
            curl = commands / "curl"
            curl.write_text('''#!/usr/bin/env python3
import json, os, pathlib, shutil, sqlite3, sys
args = sys.argv[1:]
if args[-1].endswith('/.well-known/t3/environment'):
    print(json.dumps({'serverVersion': os.environ['FIXTURE_VERSION']}))
else:
    source = 'release.tar.gz' if args[-1].endswith('/artifact') else 'release.json'
    shutil.copyfile(pathlib.Path(os.environ['HOME']) / source, args[args.index('-o') + 1])
    if source == 'release.tar.gz' and os.environ.get('FIXTURE_BUSY') == '1':
        with sqlite3.connect(os.environ['T3CODE_HEADLESS_STATE_DB']) as db:
            db.execute("UPDATE projection_turns SET state='running'")
''')
            curl.chmod(0o755)
            env = {"HOME": str(home), "PATH": str(commands),
                   "T3CODE_HEADLESS_CHANNEL": "nightly", "T3CODE_HEADLESS_NO_RESTART": "1",
                   "T3CODE_HEADLESS_BASE_URL": "https://fixture.invalid", "FIXTURE_VERSION": VERSION,
                   "T3CODE_HEADLESS_STATE_DB": str(home / "state.sqlite"),
                   "FIXTURE_BUSY": "1" if mode == "busy-during-download" else "0"}
            result = subprocess.run(["/bin/bash", str(SCRIPT), *(["--force"] if mode == "force" else [])], env=env,
                                    text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            root = home / ".local/share/t3code-server"
            if mode == "busy-during-download":
                self.assertFalse((root / "current").exists())
                self.assertTrue((root / "update-pending").exists())
                self.assertIn("update deferred until threads finish", result.stderr)
                return
            self.assertEqual((root / "current").resolve(), root / "releases" / VERSION)
            self.assertTrue((root / "current/bin/t3").is_file())
            self.assertIn(f"updated t3code.service to {VERSION}", result.stderr)


if __name__ == "__main__":
    unittest.main()
