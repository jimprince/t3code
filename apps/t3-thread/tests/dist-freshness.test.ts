import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * dist/cli.js is retained for package-style installs. If src/ changes without
 * a corresponding `npm run build`, dist drifts silently — the wrapper itself
 * runs `tsx src/cli.ts` live, so nothing in the normal workflow would surface
 * the drift until someone does `npm install -g` or invokes `node dist/cli.js`
 * directly and gets stale behavior.
 *
 * This test rebuilds to a temp file using the exact build command from
 * package.json, then byte-compares against the committed dist/cli.js. If
 * they differ, the committed dist is stale and must be rebuilt.
 */
describe("dist/cli.js freshness", () => {
  it(
    "REGRESSION: dist/cli.js matches the output of `npm run build` (if this fails: run `npm run build` and commit the updated dist/cli.js)",
    () => {
      const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
        scripts: { build: string };
      };
      const buildCmd = pkg.scripts.build;

      // The build command must write to dist/cli.js; we swap that for a
      // temp path to produce a fresh comparison bundle without touching
      // the committed artifact.
      const outfileMarker = "dist/cli.js";
      if (!buildCmd.includes(outfileMarker)) {
        throw new Error(
          `dist-freshness test expects scripts.build in package.json to write to "${outfileMarker}" so it can be redirected to a temp file. ` +
            `Current build command: ${buildCmd}. ` +
            `Update this test to match the new outfile convention.`,
        );
      }

      const tmp = mkdtempSync(join(tmpdir(), "t3-dist-freshness-"));
      const freshOutfile = join(tmp, "cli.js");
      try {
        const redirected = buildCmd.replace(outfileMarker, freshOutfile);
        // `npx --no-install` ensures we use the locally-installed esbuild
        // (as `npm run build` would) and does not silently install a new
        // version if it's missing.
        execSync(`npx --no-install ${redirected}`, { stdio: "pipe" });

        const fresh = readFileSync(freshOutfile);
        const committed = readFileSync("dist/cli.js");

        expect(
          committed.equals(fresh),
          "dist/cli.js is stale relative to src/. Run `npm run build` and commit the updated dist/cli.js.",
        ).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
