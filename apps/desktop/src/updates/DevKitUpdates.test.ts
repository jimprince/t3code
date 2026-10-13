import { assert, describe, it } from "@effect/vitest";

import {
  decideVerdict,
  describeRebuild,
  parseDevKitStatus,
  reduceStateOnDevKitVerdict,
  summarizeKitLog,
} from "./DevKitUpdates.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const status = (fetched: string, tip: string) => `branch followed: live   fetched: ${fetched}
checkout:        abc1234 on live
origin/live:  ${tip}
dev app running: yes   update worker: running
needs update:    yes (automatic updater will apply it)
`;

describe("parseDevKitStatus", () => {
  it("reads both SHAs, the verdict and whether the kit worker is busy", () => {
    assert.deepEqual(parseDevKitStatus(status("yes", "def5678")), {
      branch: "live",
      fetched: true,
      builtSha: "abc1234",
      liveSha: "def5678",
      needsUpdate: true,
      workerRunning: true,
      prebuild: null,
    });
  });

  it("flags an offline fetch, tolerates a missing tip, and rejects output that is not the kit status", () => {
    assert.equal(parseDevKitStatus(status("no", "def5678"))?.fetched, false);
    assert.equal(parseDevKitStatus(status("yes", "none"))?.liveSha, null);
    assert.equal(parseDevKitStatus("no checkout at /x (run mac-dev-setup.sh)"), null);
  });
});

describe("parseDevKitStatus with the verified-revision format", () => {
  const verified = `verified app revision: ffe290adc2629b42f4a9ca4d3a3c40e6a51f7e05
dev app running: yes   update worker: running
needs update:    yes (automatic updater will apply it)
`;

  it("takes the running build from the verified revision, even without the other lines", () => {
    assert.deepEqual(parseDevKitStatus(verified), {
      branch: "live",
      fetched: true,
      builtSha: "ffe290adc",
      liveSha: null,
      needsUpdate: true,
      workerRunning: true,
      prebuild: null,
    });
  });

  it("prefers the verified revision over the checkout and matches origin's short length", () => {
    const both = `${status("yes", "def5678")}${verified}`;
    assert.deepEqual(
      {
        built: parseDevKitStatus(both)?.builtSha,
        live: parseDevKitStatus(both)?.liveSha,
      },
      { built: "ffe290a", live: "def5678" },
    );
  });
});

describe("summarizeKitLog", () => {
  it("reports the latest step and only the pnpm progress made since it", () => {
    const log = `==> Installing dependencies (vp i)
Progress: resolved 40, reused 30, downloaded 0, added 0
Progress: resolved 812, reused 790, downloaded 2, added 700
==> Starting T3 Code (Dev) in the GUI session; log: /x/dev.log
`;
    assert.deepEqual(summarizeKitLog(log), {
      step: "Starting T3 Code (Dev) in the GUI session; log: /x/dev.log",
      progress: null,
    });
    assert.deepEqual(summarizeKitLog(log.split("==> Starting")[0]!), {
      step: "Installing dependencies (vp i)",
      progress: "resolved 812, reused 790",
    });
    assert.deepEqual(summarizeKitLog(""), { step: null, progress: null });
  });
});

describe("describeRebuild", () => {
  const input = {
    target: "def5678",
    step: "Installing dependencies (vp i)",
    progress: "resolved 12, reused 10",
    elapsedMs: 200_000,
    idleMs: 4_000,
    logPath: "/h/.t3-code-dev-kit/launch.log",
  };

  it("shows step, progress, elapsed time and last activity", () => {
    assert.equal(
      describeRebuild(input),
      "Rebuilding T3 Code (Dev) at def5678: Installing dependencies (vp i) · resolved 12, reused 10 · 3m 20s elapsed · last activity 4s ago. The app quits and relaunches when it is done.",
    );
  });

  it("says it may be stuck after two quiet minutes and names the log", () => {
    const stuck = describeRebuild({ ...input, idleMs: 125_000 });
    assert.include(
      stuck,
      "No log activity for 2m 5s; it may be stuck. Log: /h/.t3-code-dev-kit/launch.log",
    );
  });
});

describe("decideVerdict", () => {
  const stale = parseDevKitStatus(`verified app revision: ffe290adc2629b42f4a9ca4d3a3c40e6a51f7e05
origin/live:  75a6795fe
needs update:    yes (automatic updater will apply it)
`)!;
  const appSha = "75a6795fe4aa0bd5ea8ebf5e02ed24dd2d1c9fa1";

  it("never calls equal SHAs ahead, whatever the kit's flag says", () => {
    const verdict = decideVerdict(stale, appSha, null);
    assert.equal(verdict.behind, false);
    assert.equal(verdict.builtSha, "75a6795fe");
    const state = reduceStateOnDevKitVerdict(
      createInitialDesktopUpdateState(
        "1.0.0",
        { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
        "latest",
      ),
      verdict,
      "2026-10-13T00:00:00Z",
    );
    assert.equal(state.status, "up-to-date");
    assert.notInclude(state.message, "ahead");
  });

  it("is behind when the SHAs differ even if the kit says no, and falls back to the kit's build", () => {
    const kitSaysNo = { ...stale, needsUpdate: false, liveSha: "def5678ab" };
    assert.equal(decideVerdict(kitSaysNo, appSha, null).behind, true);
    assert.equal(decideVerdict(kitSaysNo, null, null).builtSha, "ffe290adc");
  });

  it("treats a difference in only hot-reloaded paths as current", () => {
    const behind = { ...stale, liveSha: "def5678ab" };
    assert.equal(decideVerdict(behind, appSha, ["apps/web/src/a.tsx", "docs/x.md"]).behind, false);
    assert.equal(
      decideVerdict(behind, appSha, ["apps/web/src/a.tsx", "apps/desktop/b.ts"]).behind,
      true,
    );
  });
});

describe("prebuild status lines", () => {
  const full = "a".repeat(40);
  const lines = (state: string, ready: string, error: string) => `origin/live:  ${"a".repeat(9)}
ready to switch: ${ready}
prebuild state: ${state}
prebuild revision: ${full}
prebuild error: ${error}
needs update:    yes
`;

  it("reads the four additive lines, and null prebuild from a kit without them", () => {
    assert.deepEqual(parseDevKitStatus(lines("failed", "none", "vp i exited 1"))?.prebuild, {
      state: "failed",
      readySha: null,
      revision: full,
      error: "vp i exited 1",
    });
    assert.equal(parseDevKitStatus(lines("ready", full, "none"))?.prebuild?.readySha, full);
    assert.equal(parseDevKitStatus(status("yes", "def5678"))?.prebuild, null);
  });

  it("calls a prepared tree ready only when it is origin's tip", () => {
    const behind = (ready: string) =>
      decideVerdict(parseDevKitStatus(lines("ready", ready, "none"))!, "b".repeat(40), null)
        .prebuild?.kind;
    assert.equal(behind(full), "ready");
    assert.equal(behind("c".repeat(40)), "stale");
  });
});
