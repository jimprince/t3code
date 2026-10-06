"""Production deploy-path checks; fixtures stub builds and the user service only."""
import os
import json
import shutil
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
        real_node = shutil.which("node")
        self.watcher = subprocess.Popen([real_node, "-e", "setInterval(() => {}, 1000)"], cwd=self.snap / self.sha / "apps/t3-thread")
        self.addCleanup(self.stop_watcher)
        self.env["TEST_PID"] = str(self.watcher.pid)
        stat = Path(f"/proc/{self.watcher.pid}/stat").read_text()
        self.lease = dict(pid=self.watcher.pid, bootId=Path("/proc/sys/kernel/random/boot_id").read_text().strip(), startTime=stat[stat.rfind(")") + 2:].split()[19])
        lease_path = self.root / ".config/t3-remote-agents/watch.pid"
        lease_path.parent.mkdir(parents=True)
        lease_path.write_text(json.dumps(self.lease))
        self.stub("node", f'if [ "$1" = "-" ]; then exec "{real_node}" "$@"; fi; ' + 'echo build >> "$TEST_LOG"; [ "${TEST_BUILD_FAIL:-0}" = 0 ]')
        self.stub("systemctl", '\n'.join([
            'echo "$*" >> "$TEST_LOG"',
            'case "$*" in',
            '  *MainPID*) echo "$TEST_PID" ;;',
            '  *show*) echo "$TEST_LOADED" ;;',
            '  *restart*) [ "$(readlink "$TEST_SNAP/current")" = "$TEST_SHA" ] && [ -f "$TEST_SNAP/old/keep" ] && [ "${TEST_RESTART_FAIL:-0}" = 0 ] ;;',
            '  *is-active*) [ "${TEST_INACTIVE:-0}" = 0 ] ;;',
            '  *) exit 99 ;;',
            'esac',
        ]))

    def stop_watcher(self):
        self.watcher.terminate()
        self.watcher.wait(timeout=5)

    def stub(self, name, body):
        p = self.bin / name
        p.write_text("#!/bin/sh\n" + body + "\n")
        p.chmod(0o755)

    def deploy(self, *args):
        return subprocess.run(["bash", str(SCRIPT), *args], env=self.env, capture_output=True, text=True)

    def events(self):
        return (self.root / "events").read_text() if (self.root / "events").exists() else ""

    def commit_source_fixture(self, *paths):
        subprocess.run(["git", "-C", self.repo, "add", "--", *paths], check=True)
        subprocess.run(["git", "-C", self.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source fixture"], check=True)
        return subprocess.check_output(["git", "-C", self.repo, "rev-parse", "HEAD"], text=True).strip()

    def assert_nonmutating_new_ref_dry_run(self, requested):
        target = self.snap / requested[:8]
        self.assertFalse(target.exists())
        before = sorted(p.name for p in self.snap.iterdir())
        result = self.deploy("--dry-run", "--retain-snapshots", "--ref", requested)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("bun install --frozen-lockfile", result.stdout, "dry-run must use requested-ref manager, not HEAD or worktree")
        self.assertNotIn("pnpm install --frozen-lockfile", result.stdout)
        self.assertIn("would verify:", result.stdout)
        self.assertIn("would restart and verify:", result.stdout)
        self.assertEqual(sorted(p.name for p in self.snap.iterdir()), before)
        self.assertFalse(target.exists(), "dry-run created a destination directory")
        self.assertEqual(os.readlink(self.snap / "current"), "old")
        self.assertEqual((self.snap / "old/keep").read_text(), "old runtime")
        self.assertNotIn("build", self.events())
        self.assertNotIn("restart", self.events())

    def test_dry_run_new_snapshot_reads_exact_requested_ref(self):
        package = self.repo / "package.json"
        package.write_text('{"packageManager":"bun@1.3.0"}')
        requested = self.commit_source_fixture("package.json")
        package.write_text('{"packageManager":"pnpm@11.10.0"}')
        self.commit_source_fixture("package.json")
        self.assert_nonmutating_new_ref_dry_run(requested)

    def test_dry_run_lockfile_fallback_reads_exact_requested_ref(self):
        (self.repo / "package.json").write_text("{}")
        (self.repo / "bun.lock").write_text("fixture lock")
        requested = self.commit_source_fixture("package.json", "bun.lock")
        (self.repo / "bun.lock").unlink()
        (self.repo / "pnpm-lock.yaml").write_text("fixture lock")
        self.commit_source_fixture("bun.lock", "pnpm-lock.yaml")
        self.assert_nonmutating_new_ref_dry_run(requested)

    def test_ordinary_install_uses_checked_out_requested_ref(self):
        (self.repo / "apps/t3-thread").mkdir(parents=True)
        (self.repo / "apps/t3-thread/package.json").write_text("{}")
        (self.repo / "package.json").write_text('{"packageManager":"bun@1.3.0"}')
        requested = self.commit_source_fixture("package.json", "apps/t3-thread/package.json")
        (self.repo / "package.json").write_text('{"packageManager":"pnpm@11.10.0"}')
        self.commit_source_fixture("package.json")
        self.stub("bun", 'echo install-bun >> "$TEST_LOG"')
        self.stub("pnpm", 'echo install-pnpm >> "$TEST_LOG"; exit 99')
        self.env["TEST_LOADED"] = "not-found"
        result = self.deploy("--retain-snapshots", "--ref", requested)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("install-bun", self.events())
        self.assertNotIn("install-pnpm", self.events())
        self.assertEqual(os.readlink(self.snap / "current"), requested[:8])
        self.assertEqual((self.snap / requested[:8] / "package.json").read_text(), '{"packageManager":"bun@1.3.0"}')
        self.assertEqual((self.snap / "old/keep").read_text(), "old runtime")

    def prepare_failing_new_snapshot(self):
        self.stop_watcher()
        shutil.rmtree(self.snap / self.sha)
        # The real clone succeeds, then the helper rejects the missing workspace.
        # That production ERR-trap path normally removes the partial snapshot.

    def test_retain_snapshots_promotes_and_restarts_without_pruning(self):
        result = self.deploy("--retain-snapshots")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(self.snap / "current"), self.sha)
        self.assertTrue((self.snap / "old/keep").is_file(), "successful retained deployment deleted its predecessor")
        self.assertEqual((self.snap / "old/keep").read_text(), "old runtime")
        self.assertTrue((self.snap / self.sha / "apps/t3-thread").is_dir())
        self.assertIn("--user restart t3-thread-watcher.service", self.events())

    def test_retain_snapshots_preserves_partial_and_current_on_workspace_failure(self):
        self.prepare_failing_new_snapshot()
        result = self.deploy("--retain-snapshots")
        self.assertNotEqual(result.returncode, 0, "missing workspace must stop deployment")
        self.assertTrue((self.snap / self.sha / "fixture").is_file(), "failed new snapshot was deleted despite retention")
        self.assertEqual(os.readlink(self.snap / "current"), "old")
        self.assertEqual((self.snap / "old/keep").read_text(), "old runtime")
        self.assertIn("has no apps/t3-thread workspace", result.stderr)
        self.assertNotIn("restart", self.events())

    def test_default_workspace_failure_removes_partial_and_keeps_current(self):
        self.prepare_failing_new_snapshot()
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.snap / self.sha).exists(), "default failed-snapshot cleanup changed")
        self.assertEqual(os.readlink(self.snap / "current"), "old")
        self.assertEqual((self.snap / "old/keep").read_text(), "old runtime")
        self.assertIn("has no apps/t3-thread workspace", result.stderr)
        self.assertNotIn("restart", self.events())

    def test_retain_snapshots_prune_only_preserves_all_snapshots(self):
        result = self.deploy("--retain-snapshots", "--prune-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(self.snap / "current"), "old")
        self.assertEqual((self.snap / "old/keep").read_text(), "old runtime")
        self.assertTrue((self.snap / self.sha / "apps/t3-thread").is_dir())
        self.assertEqual(self.events(), "")

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
        (self.snap / "current").unlink()
        (self.snap / "current").symlink_to(self.sha)
        self.assertEqual(self.deploy("--dry-run").returncode, 0)
        self.assertEqual(os.readlink(self.snap / "current"), self.sha)
        self.assertNotIn("restart", self.events())
        self.assertEqual(self.deploy("--prune-only").returncode, 0)
        self.assertNotIn("restart", self.events())

    def test_foreign_lease_stops_pruning(self):
        self.lease["startTime"] = "invalid"
        (self.root / ".config/t3-remote-agents/watch.pid").write_text(json.dumps(self.lease))
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.snap / "old/keep").exists())
        self.assertIn("does not own the live lease", result.stderr)

    def use_unmanaged_predecessor(self):
        self.stop_watcher()
        self.watcher = subprocess.Popen([shutil.which("node"), "-e", "setInterval(() => {}, 1000)"], cwd=self.snap / "old")
        self.env["TEST_LOADED"] = "not-found"
        stat = Path(f"/proc/{self.watcher.pid}/stat").read_text()
        self.lease.update(pid=self.watcher.pid, startTime=stat[stat.rfind(")") + 2:].split()[19])
        (self.root / ".config/t3-remote-agents/watch.pid").write_text(json.dumps(self.lease))

    def test_unmanaged_predecessor_survives_deploy_prune(self):
        self.use_unmanaged_predecessor()
        result = self.deploy()
        self.assertTrue((self.snap / "old/keep").exists(), "live unmanaged runtime was deleted")
        self.assertNotEqual(result.returncode, 0, "live unmanaged predecessor must prevent pruning")
        self.assertIsNone(self.watcher.poll())

    def test_unmanaged_predecessor_survives_prune_only(self):
        self.use_unmanaged_predecessor()
        (self.snap / "current").unlink()
        (self.snap / "current").symlink_to(self.sha)
        result = self.deploy("--prune-only")
        self.assertTrue((self.snap / "old/keep").exists(), "prune-only deleted the live unmanaged runtime")
        self.assertNotEqual(result.returncode, 0, "prune-only must preserve the live predecessor")
        self.assertIsNone(self.watcher.poll())

    def test_prune_without_lease_remains_supported(self):
        (self.root / ".config/t3-remote-agents/watch.pid").unlink()
        (self.snap / "current").unlink()
        (self.snap / "current").symlink_to(self.sha)
        self.assertEqual(self.deploy("--prune-only").returncode, 0)
        self.assertFalse((self.snap / "old").exists())

    def test_stale_process_identity_does_not_block_prune(self):
        self.use_unmanaged_predecessor()
        self.lease["startTime"] = "0"
        (self.root / ".config/t3-remote-agents/watch.pid").write_text(json.dumps(self.lease))
        (self.snap / "current").unlink()
        (self.snap / "current").symlink_to(self.sha)
        self.assertEqual(self.deploy("--prune-only").returncode, 0)
        self.assertFalse((self.snap / "old").exists())

    def test_unknown_or_legacy_live_lease_prevents_prune(self):
        (self.snap / "current").unlink()
        (self.snap / "current").symlink_to(self.sha)
        for raw in ["not-json", str(self.watcher.pid)]:
            with self.subTest(raw=raw):
                (self.root / ".config/t3-remote-agents/watch.pid").write_text(raw)
                self.assertNotEqual(self.deploy("--prune-only").returncode, 0)
                self.assertTrue((self.snap / "old/keep").exists())

    def test_custom_state_path_protects_unmanaged_predecessor(self):
        self.use_unmanaged_predecessor()
        custom = self.root / "custom/watch.pid"
        custom.parent.mkdir()
        custom.write_text(json.dumps(self.lease))
        self.env["T3_AGENT_STATE_FILE"] = str(custom.parent / "state.json")
        (self.root / ".config/t3-remote-agents/watch.pid").unlink()
        (self.snap / "current").unlink()
        (self.snap / "current").symlink_to(self.sha)
        self.assertNotEqual(self.deploy("--prune-only").returncode, 0)
        self.assertTrue((self.snap / "old/keep").exists())

    def test_inactive_after_restart_stops_pruning(self):
        self.env["TEST_INACTIVE"] = "1"
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertTrue((self.snap / "old/keep").exists())


if __name__ == "__main__":
    unittest.main()
