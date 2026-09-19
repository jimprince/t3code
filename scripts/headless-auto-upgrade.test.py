"""Exercise the Linux updater with cron's environment and a disposable release."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
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
            home = Path(directory).resolve()
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


class CronUpgradeTest(unittest.TestCase):
    def test_cron_installs_self_contained_release_without_node(self):
        self.run_upgrade("idle")

    def test_existing_version_is_a_no_op(self):
        self.run_upgrade("no-op")

    def test_failed_health_check_rolls_back(self):
        self.run_upgrade("rollback")

    def test_node_based_current_release_remains_a_valid_rollback_target(self):
        self.run_upgrade("legacy-current")

    def test_work_started_during_download_defers_without_changing_current(self):
        self.run_upgrade("busy-during-download")

    def test_only_explicit_force_can_upgrade_while_busy(self):
        self.run_upgrade("force")

    def test_orphaned_staging_is_swept_without_touching_live_owner(self):
        self.run_upgrade("orphan-sweep")

    def test_failed_staging_is_removed_by_exit_cleanup(self):
        self.run_upgrade("invalid-staged-version")

    def run_upgrade(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            seed_idle(home / "state.sqlite")
            if mode == "force":
                with sqlite3.connect(home / "state.sqlite") as db:
                    db.execute("UPDATE projection_turns SET state='running'")
            commands = home / "commands"
            commands.mkdir()
            # Deliberately expose system utilities without Node. New releases
            # must run from their embedded runtime.
            for name in ("bash", "python3", "mktemp", "rm", "mkdir", "tar",
                         "ln", "readlink", "sort", "awk", "seq", "gzip"):
                (commands / name).symlink_to(
                    shutil.which(name, path="/usr/bin:/bin:/usr/sbin:/sbin")
                )
            # macOS lacks the three GNU/Linux operations used by the installer.
            # Model their exact call shapes so the updater workflow itself can
            # run locally; release CI still exercises the native utilities.
            flock = commands / "flock"
            flock.write_text("#!/bin/sh\nexit 0\n")
            flock.chmod(0o755)
            mv = commands / "mv"
            mv.write_text('''#!/usr/bin/env python3
import os, shutil, sys
args = sys.argv[1:]
if args[0] == '-Tf':
    os.replace(args[1], args[2])
else:
    shutil.move(args[0], args[1])
''')
            mv.chmod(0o755)
            find = commands / "find"
            find.write_text('''#!/usr/bin/env python3
import pathlib, sys
root = pathlib.Path(sys.argv[1])
if root.exists():
    for path in root.iterdir():
        if path.is_dir():
            print(f'{path.stat().st_mtime} {path}')
''')
            find.chmod(0o755)
            reported_version = "invalid" if mode == "invalid-staged-version" else VERSION
            release = home / "artifact"
            (release / "bin").mkdir(parents=True)
            executable = release / "t3"
            executable.write_text(f'#!/bin/sh\necho "T3 Code {reported_version}"\n')
            executable.chmod(0o755)
            launcher = release / "bin/t3"
            launcher.write_text('#!/bin/sh\nscript_dir=${0%/*}\nexec "$script_dir/../t3" "$@"\n')
            launcher.chmod(0o755)
            archive = home / "release.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(release, arcname="headless")
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
    root = pathlib.Path(os.environ['HOME']) / '.local/share/t3code-server'
    current = (root / 'current').resolve().name
    version = 'failed-new-release' if os.environ.get('FIXTURE_FAIL_NEW') == '1' and current == os.environ['FIXTURE_VERSION'] else current
    print(json.dumps({'serverVersion': version}))
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
                   "T3CODE_HEADLESS_HEALTH_ATTEMPTS": "1",
                   "FIXTURE_BUSY": "1" if mode == "busy-during-download" else "0",
                   "FIXTURE_FAIL_NEW": "1" if mode == "rollback" else "0"}
            root = home / ".local/share/t3code-server"
            previous_version = "0.0.38-nightly.20260905.1200-fork.1"
            if mode in ("rollback", "legacy-current"):
                previous = root / "releases" / previous_version
                (previous / "bin").mkdir(parents=True)
                previous_launcher = previous / "bin/t3"
                if mode == "legacy-current":
                    node = home / ".local/node/bin/node"
                    node.parent.mkdir(parents=True)
                    node.write_text(f'#!/bin/sh\necho "T3 Code {previous_version}"\n')
                    node.chmod(0o755)
                    previous_launcher.write_text('#!/bin/sh\nexec node "$@"\n')
                else:
                    previous_launcher.write_text(
                        f'#!/bin/sh\necho "T3 Code {previous_version}"\n'
                    )
                previous_launcher.chmod(0o755)
                root.mkdir(parents=True, exist_ok=True)
                (root / "current").symlink_to(previous)
            elif mode == "no-op":
                installed = root / "releases" / VERSION
                (installed / "bin").mkdir(parents=True)
                root.mkdir(parents=True, exist_ok=True)
                (root / "current").symlink_to(installed)
            if mode == "orphan-sweep":
                staging = root / ".staging"
                dead_process = subprocess.Popen(
                    [shutil.which("true", path="/usr/bin:/bin")]
                )
                dead_process.wait(timeout=5)
                dead_stage = staging / f"old.{dead_process.pid}"
                live_stage = staging / f"old.{os.getpid()}"
                dead_stage.mkdir(parents=True)
                live_stage.mkdir()
            result = subprocess.run(["/bin/bash", str(SCRIPT), *(["--force"] if mode == "force" else [])], env=env,
                                    text=True, capture_output=True, timeout=15)
            if mode == "no-op":
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"already on {VERSION}", result.stderr)
                return
            if mode == "rollback":
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(
                    (root / "current").resolve(),
                    (root / "releases" / previous_version).resolve(),
                )
                self.assertIn("rolled back current", result.stderr)
                self.assertNotIn("rollback health check failed", result.stderr)
                return
            if mode == "invalid-staged-version":
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(list((root / ".staging").iterdir()), [])
                self.assertFalse((root / "current").exists())
                return
            self.assertEqual(result.returncode, 0, result.stderr)
            if mode == "busy-during-download":
                self.assertFalse((root / "current").exists())
                self.assertTrue((root / "update-pending").exists())
                self.assertIn("update deferred until threads finish", result.stderr)
                return
            if mode == "orphan-sweep":
                self.assertFalse(dead_stage.exists())
                self.assertTrue(live_stage.exists())
                self.assertIn(f"removed orphaned staging directory {dead_stage}", result.stderr)
            self.assertEqual(
                (root / "current").resolve(), (root / "releases" / VERSION).resolve()
            )
            self.assertTrue((root / "current/bin/t3").is_file())
            self.assertIn(f"updated t3code.service to {VERSION}", result.stderr)


if __name__ == "__main__":
    unittest.main()
