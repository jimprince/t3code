// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import {
  assertCandidateScope,
  assertPatchPrefixUnchanged,
  formatInventoryStanza,
  validateCandidateManifest,
} from "./lib/stgit-candidate.ts";
import { createFixtureRepo } from "./lib/git-fixture.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

const sha = (digit: string): string => digit.repeat(40);

const validManifest = {
  contract: "t3code.stgit-candidate/v1",
  baseMain: sha("1"),
  baseStack: sha("2"),
  candidate: sha("3"),
  patch: {
    name: "fork-remote-artifact-downloads",
    subject: "feat(remote): download generated artifacts",
    class: "product",
    purpose: "Let remote clients retrieve files produced by an agent.",
    retireWhen: "never",
    dependsOn: ["fork-remote-project-access"],
  },
  allowedPaths: ["apps/web/src/download.ts", "apps/server/src/routes/artifacts.ts"],
  verification: [
    ["vp", "test", "run", "apps/server/src/routes/artifacts.test.ts"],
    ["vp", "run", "typecheck", "--filter", "@t3-oss/web"],
  ],
} as const;

describe("StGit candidate contract", () => {
  it("normalizes a valid manifest deterministically", () => {
    const manifest = validateCandidateManifest(validManifest);
    assert.deepEqual(manifest.allowedPaths, [
      "apps/server/src/routes/artifacts.ts",
      "apps/web/src/download.ts",
    ]);
    assert.deepEqual(manifest.verification, validManifest.verification);
  });

  it("rejects escaping paths and shell-shaped verification commands", () => {
    assert.throws(() =>
      validateCandidateManifest({ ...validManifest, allowedPaths: ["../outside"] }),
    );
    assert.throws(() => validateCandidateManifest({ ...validManifest, verification: ["vp test"] }));
  });

  it("rejects dirty paths outside the declared concern", () => {
    assert.throws(() =>
      assertCandidateScope(validManifest.allowedPaths, [
        "apps/web/src/download.ts",
        "apps/desktop/src/unrelated.ts",
        "docs/operations/fork-inventory.toml",
      ]),
    );
    assert.doesNotThrow(() =>
      assertCandidateScope(validManifest.allowedPaths, [
        "apps/server/src/routes/artifacts.ts",
        "apps/web/src/download.ts",
        "docs/operations/fork-inventory.toml",
      ]),
    );
  });

  it("requires every pre-existing patch to retain order, name, subject, and oid", () => {
    const before = [
      { name: "one", subject: "feat: one", oid: sha("4") },
      { name: "two", subject: "feat: two", oid: sha("5") },
    ];
    assert.doesNotThrow(() =>
      assertPatchPrefixUnchanged(before, [
        ...before,
        { name: validManifest.patch.name, subject: validManifest.patch.subject, oid: sha("6") },
      ]),
    );
    assert.throws(() =>
      assertPatchPrefixUnchanged(before, [
        before[1]!,
        before[0]!,
        {
          name: validManifest.patch.name,
          subject: validManifest.patch.subject,
          oid: sha("6"),
        },
      ]),
    );
  });

  it("renders the inventory stanza owned by the new patch", () => {
    assert.strictEqual(
      formatInventoryStanza(validManifest.patch),
      [
        "[[patch]]",
        'name = "fork-remote-artifact-downloads"',
        'subject = "feat(remote): download generated artifacts"',
        'class = "product"',
        'purpose = "Let remote clients retrieve files produced by an agent."',
        'retire_when = "never"',
        'depends_on = ["fork-remote-project-access"]',
        "roles = []",
        "",
      ].join("\n"),
    );
  });

  it("creates a reviewable manifest from one candidate commit and remote leases", () => {
    const repo = createFixtureRepo();
    try {
      const base = repo.git("rev-parse", "HEAD");
      repo.git("update-ref", "refs/stacks/stgit/adopt", base);
      repo.git("switch", "--create", "candidate");
      repo.writeFile("apps/web/artifact.ts", "export const artifact = true;\n");
      const candidate = repo.commitAll("feat(remote): download artifacts");
      repo.git("switch", "main");
      const output = NodePath.join(repo.dir, "candidate.json");
      const result = NodeChildProcess.spawnSync(
        NodePath.join(repoRoot, "scripts/ci/create-stgit-candidate-manifest"),
        [
          "--candidate",
          candidate,
          "--name",
          "fork-remote-artifact-downloads",
          "--subject",
          "feat(remote): download generated artifacts",
          "--class",
          "product",
          "--purpose",
          "Let remote clients retrieve files produced by an agent.",
          "--retire-when",
          "never",
          "--verification-json",
          '[["vp","test","run","apps/web/artifact.test.ts"]]',
          "--remote",
          repo.dir,
          "--output",
          output,
        ],
        { cwd: repo.dir, encoding: "utf8", env: { ...process.env, SYNC_GIT_BIN: "/usr/bin/git" } },
      );
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      const manifest = validateCandidateManifest(JSON.parse(NodeFS.readFileSync(output, "utf8")));
      assert.strictEqual(manifest.baseMain, base);
      assert.strictEqual(manifest.baseStack, base);
      assert.strictEqual(manifest.candidate, candidate);
      assert.deepEqual(manifest.allowedPaths, ["apps/web/artifact.ts"]);
    } finally {
      repo.cleanup();
    }
  });
});
