"""Production deploy-path checks; fixtures stub builds and the user service only."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "bin/t3-thread-deploy"


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="t3-deploy-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        (self.repo / "fixture").write_text("snapshot")
        subprocess.run(["git", "-C", self.repo, "add", "fixture"], check=True)
        subprocess.run(["git", "-C", self.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
        self.sha = subprocess.check_output(["git", "-C", self.repo, "rev-parse", "--short=8", "HEAD"], text=True).strip()
        self.snap = self.root / "snap"
        (self.snap / self.sha / "apps/t3-thread").mkdir(parents=True)
        (self.snap / "old").mkdir()
        (self.snap / "old/keep").write_text("old runtime")
        (self.snap / "current").symlink_to("old")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ, PATH=f"{self.bin}:/usr/bin:/bin", T3_THREAD_SOURCE_REPO=str(self.repo), T3_THREAD_SNAPSHOT_ROOT=str(self.snap), TEST_LOG=str(self.root / "events"), TEST_SNAP=str(self.snap), TEST_SHA=self.sha, TEST_LOADED="loaded", HOME=str(self.root), XDG_CONFIG_HOME=str(self.root / "config"))
        self.stub("node", 'echo build >> "$TEST_LOG"; [ "${TEST_BUILD_FAIL:-0}" = 0 ]')
        self.stub("systemctl", '\n'.join([
            'echo "$*" >> "$TEST_LOG"',
            'case "$*" in',
            '  *show*) echo "$TEST_LOADED" ;;',
            '  *restart*) [ "$(readlink "$TEST_SNAP/current")" = "$TEST_SHA" ] && [ -f "$TEST_SNAP/old/keep" ] && [ "${TEST_RESTART_FAIL:-0}" = 0 ] ;;',
            '  *is-active*) [ "${TEST_INACTIVE:-0}" = 0 ] ;;',
            '  *) exit 99 ;;',
            'esac',
        ]))

    def stub(self, name, body):
        p = self.bin / name
        p.write_text("#!/bin/sh\n" + body + "\n")
        p.chmod(0o755)

    def deploy(self, *args):
        return subprocess.run(["bash", str(SCRIPT), *args], env=self.env, capture_output=True, text=True)

    def events(self):
        return (self.root / "events").read_text() if (self.root / "events").exists() else ""

    def test_restart_after_promotion_before_prune(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--user restart t3-thread-watcher.service", self.events(), "managed watcher must adopt promoted runtime before pruning")
        self.assertIn("--user is-active --quiet t3-thread-watcher.service", self.events())
        self.assertFalse((self.snap / "old").exists())
        self.assertEqual(os.readlink(self.snap / "current"), self.sha)

    def test_failed_restart_preserves_previous_runtime(self):
        self.env["TEST_RESTART_FAIL"] = "1"
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0, "failed restart must stop pruning")
        self.assertTrue((self.snap / "old/keep").exists())

    def test_failed_build_does_not_promote_or_restart(self):
        self.env["TEST_BUILD_FAIL"] = "1"
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(os.readlink(self.snap / "current"), "old")
        self.assertNotIn("restart", self.events())

    def test_no_managed_unit_keeps_existing_deploy_supported(self):
        self.env["TEST_LOADED"] = "not-found"
        self.assertEqual(self.deploy().returncode, 0)
        self.assertNotIn("restart", self.events())

    def test_configured_unit_without_user_bus_stops_pruning(self):
        self.env["TEST_LOADED"] = ""
        unit = self.root / "config/systemd/user/t3-thread-watcher.service"
        unit.parent.mkdir(parents=True)
        unit.write_text("configured unit")
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertTrue((self.snap / "old/keep").exists())

    def test_dry_run_and_prune_only_never_restart(self):
        self.assertEqual(self.deploy("--dry-run").returncode, 0)
        self.assertEqual(os.readlink(self.snap / "current"), "old")
        self.assertNotIn("restart", self.events())
        self.assertEqual(self.deploy("--prune-only").returncode, 0)
        self.assertNotIn("restart", self.events())

    def test_inactive_after_restart_stops_pruning(self):
        self.env["TEST_INACTIVE"] = "1"
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertTrue((self.snap / "old/keep").exists())


if __name__ == "__main__":
    unittest.main()
