// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, it } from "vite-plus/test";

describe("headless staged promotion and rollback", () => {
  it.each([
    "ActivityGuardTest.test_completed_and_idle_threads_allow_update",
    "ActivityGuardTest.test_active_work_blocks_update_without_changing_install",
    "ActivityGuardTest.test_queued_followup_prevents_restart",
    "ActivityGuardTest.test_unreadable_or_unknown_state_never_means_idle",
    "V2ActivityGuardTest.test_v2_activity_and_snapshot_are_readonly",
    "CronUpgradeTest.test_cron_installs_self_contained_release_without_node",
    "CronUpgradeTest.test_existing_version_is_a_no_op",
    "CronUpgradeTest.test_protocol_mismatch_rolls_back",
    "CronUpgradeTest.test_failed_health_check_rolls_back",
    "CronUpgradeTest.test_node_based_current_release_remains_a_valid_rollback_target",
    "CronUpgradeTest.test_work_started_during_download_defers_without_changing_current",
    "CronUpgradeTest.test_only_explicit_force_can_upgrade_while_busy",
    "CronUpgradeTest.test_orphaned_staging_is_swept_without_touching_live_owner",
    "CronUpgradeTest.test_failed_staging_is_removed_by_exit_cleanup",
  ])(
    "%s",
    (testCase) => {
      NodeChildProcess.execFileSync(
        "python3",
        [
          NodeURL.fileURLToPath(new URL("./headless-auto-upgrade.test.py", import.meta.url)),
          testCase,
        ],
        {
          timeout: 60_000,
          stdio: "pipe",
        },
      );
    },
    65_000,
  );
});
