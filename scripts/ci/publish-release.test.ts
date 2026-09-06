// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "vite-plus/test";

// Execute the shipped workflow step with a stateful GitHub CLI fixture.
const workflow = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)),
  "utf8",
);
const publishStep = workflow.split("      - name: Publish release\n")[1]!;
const script = publishStep
  .split("        run: |\n")[1]!
  .split("\n")
  .map((line) => line.replace(/^          /, ""))
  .join("\n");
const assets = ["app.dmg", "app.zip", "server.tar.gz", "nightly-mac.yml"];

function publish(options: Record<string, string> = {}) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-publish-release-"));
  try {
    NodeFS.mkdirSync(NodePath.join(dir, "bin"));
    NodeFS.mkdirSync(NodePath.join(dir, "release-assets"));
    NodeFS.mkdirSync(NodePath.join(dir, "scripts/ci"), { recursive: true });
    for (const asset of assets)
      NodeFS.writeFileSync(NodePath.join(dir, "release-assets", asset), "artifact");
    NodeFS.writeFileSync(
      NodePath.join(dir, "scripts/ci/render-release-notes"),
      '#!/bin/sh\necho notes > "$1"\n',
      {
        mode: 0o755,
      },
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, "state.json"),
      JSON.stringify({ exists: true, isDraft: true, publishedAt: null, assets: [], calls: [] }),
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, "bin/gh"),
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
const args = process.argv.slice(2);
const command = args.slice(0, 2).join(" ");
state.calls.push([command, process.env.GH_TOKEN]);
const fail = (message) => { fs.writeFileSync("state.json", JSON.stringify(state)); console.error(message); process.exit(1); };
const upload = () => {
  if (process.env.FAIL_UPLOAD === "true" || (process.env.FAIL_PAT === "true" && process.env.GH_TOKEN === "fixture-pat")) fail("upload failed");
  state.assets = args.filter(x => x.startsWith("release-assets/")).map(x => ({name: path.basename(x), size: 8, state: "uploaded"}));
};
switch (command) {
  case "api repos/owner/fork": break;
  case "release view":
    if (!state.exists || (process.env.NEW_RELEASE === "true" && !state.created)) fail("not found");
    if (args.includes("--json")) {
      if (process.env.FAIL_READBACK === "true") fail("readback unavailable");
      const assets = process.env.MISSING_ASSET === "true" ? state.assets.slice(1) : state.assets;
      console.log(JSON.stringify({...state, assets, tagName: "v1.2.3-fork.1", isPrerelease: process.env.RELEASE_PRERELEASE === "true"}));
    }
    break;
  case "release create":
    state.exists = true; state.created = true; state.isDraft = args.includes("--draft");
    state.publishedAt = state.isDraft ? null : "2026-09-19T00:00:00Z";
    upload();
    break;
  case "release upload": upload(); break;
  case "release edit":
    if (args.includes("--draft=false") && process.env.IGNORE_EDIT !== "true") { state.isDraft = false; state.publishedAt = "2026-09-19T00:00:00Z"; }
    break;
  default: fail("unexpected command: " + args.join(" "));
}
fs.writeFileSync("state.json", JSON.stringify(state));
`,
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync("/bin/bash", ["-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${NodePath.join(dir, "bin")}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GH_PAT: "fixture-pat",
        GITHUB_TOKEN: "fixture-token",
        RELEASE_REPO: "owner/fork",
        RELEASE_TAG: "v1.2.3-fork.1",
        RELEASE_TARGET: "fixture-sha",
        RELEASE_NAME: "Fixture",
        RELEASE_PREVIOUS_TAG: "",
        RELEASE_PRERELEASE: "true",
        RELEASE_MAKE_LATEST: "false",
        ...options,
      },
    });
    const state = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "state.json"), "utf8")) as {
      isDraft: boolean;
      publishedAt: string | null;
      assets: { name: string }[];
      calls: [string, string][];
    };
    return { ...result, state };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

describe("release publication", () => {
  const cases: Record<string, string>[] = [
    {},
    { NEW_RELEASE: "true" },
    { RELEASE_PRERELEASE: "false" },
  ];
  for (const options of cases) {
    it(`publishes complete assets and verifies public state: ${JSON.stringify(options)}`, () => {
      const result = publish(options);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.isFalse(result.state.isDraft);
      assert.isNotNull(result.state.publishedAt);
      assert.sameMembers(
        result.state.assets.map((asset) => asset.name),
        assets,
      );
    });
  }

  it("leaves interrupted uploads in draft without attempting publication", () => {
    const result = publish({ FAIL_UPLOAD: "true" });
    assert.strictEqual(result.status, 1);
    assert.isTrue(result.state.isDraft);
    assert.isFalse(result.state.calls.some(([command]) => command === "release edit"));
  });

  it("recovers through the alternate token after an upload fails", () => {
    const result = publish({ FAIL_PAT: "true" });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.isFalse(result.state.isDraft);
    assert.deepInclude(result.state.calls, ["release edit", "fixture-token"]);
  });

  for (const failure of ["IGNORE_EDIT", "MISSING_ASSET", "FAIL_READBACK"]) {
    it(`rejects incomplete publication despite successful commands: ${failure}`, () => {
      const result = publish({ [failure]: "true" });
      assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    });
  }
});
