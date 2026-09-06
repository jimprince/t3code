// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LOG_MAX_AGE_MS,
  pruneLogDirectory,
  selectLogFilesForPruning,
} from "./LogRetention.ts";

describe("LogRetention", () => {
  it("removes expired files first, then the oldest files until under the global cap", () => {
    const nowMs = Date.parse("2026-07-23T00:00:00.000Z");
    const selected = selectLogFilesForPruning(
      [
        {
          path: "/logs/expired.log",
          sizeBytes: 20,
          modifiedAtMs: nowMs - DEFAULT_LOG_MAX_AGE_MS - 1,
        },
        { path: "/logs/oldest.log", sizeBytes: 60, modifiedAtMs: nowMs - 3_000 },
        { path: "/logs/newest.log", sizeBytes: 60, modifiedAtMs: nowMs - 1_000 },
      ],
      {
        nowMs,
        maxAgeMs: DEFAULT_LOG_MAX_AGE_MS,
        maxTotalBytes: 60,
      },
    );

    expect(selected.map((file) => file.path)).toEqual(["/logs/expired.log", "/logs/oldest.log"]);
  });

  it("prunes nested logs and creates the Spotlight exclusion marker", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-log-retention-"));
    const nested = NodePath.join(root, "provider");
    NodeFS.mkdirSync(nested);
    const oldPath = NodePath.join(nested, "old.log");
    const newPath = NodePath.join(nested, "new.log");
    NodeFS.writeFileSync(oldPath, "old");
    NodeFS.writeFileSync(newPath, "new");
    const nowMs = Date.parse("2026-07-23T00:00:00.000Z");
    NodeFS.utimesSync(oldPath, (nowMs - 10_000) / 1_000, (nowMs - 10_000) / 1_000);

    try {
      const result = pruneLogDirectory(root, {
        nowMs,
        maxAgeMs: 5_000,
        maxTotalBytes: 1_024,
      });

      expect(result.deletedPaths).toEqual([oldPath]);
      expect(NodeFS.existsSync(oldPath)).toBe(false);
      expect(NodeFS.existsSync(newPath)).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(root, ".metadata_never_index"))).toBe(true);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
