import { assert, describe, it } from "@effect/vitest";

import { parseDevKitStatus } from "./DevKitUpdates.ts";

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
    });
  });

  it("flags an offline fetch and rejects output that is not the kit status", () => {
    assert.equal(parseDevKitStatus(status("no", "def5678"))?.fetched, false);
    assert.equal(parseDevKitStatus(status("yes", "none")), null);
    assert.equal(parseDevKitStatus("no checkout at /x (run mac-dev-setup.sh)"), null);
  });
});
