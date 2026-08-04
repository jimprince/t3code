// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { checkForkDocs } from "./check-fork-docs.ts";

const write = (root: string, path: string, contents: string): void => {
  const target = NodePath.join(root, path);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, contents);
};

const createValidDocs = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-docs-"));
  write(root, "AGENTS.md", "Read [LLM_INSTRUCTIONS.md](./LLM_INSTRUCTIONS.md).\n");
  write(
    root,
    "LLM_INSTRUCTIONS.md",
    [
      "Read the [fork patch stack skill](./.agents/skills/fork-patch-stack/SKILL.md).",
      "Read the [maintenance runbook](./docs/operations/fork-maintenance.md).",
      "Read the [inventory](./docs/operations/fork-inventory.toml).",
    ].join("\n"),
  );
  write(
    root,
    ".agents/skills/fork-patch-stack/SKILL.md",
    [
      "---",
      "name: fork-patch-stack",
      "description: Maintain the fork patch stack.",
      "---",
      "# Fork patch stack",
      "## Rebase workflow",
      "Run `stg rebase` and never run `stg new` during a rebase.",
      "## New-concern workflow",
      "Run `stg new` for an independent feature.",
      "Read the [runbook](../../../docs/operations/fork-maintenance.md) and [inventory](../../../docs/operations/fork-inventory.toml).",
    ].join("\n"),
  );
  write(
    root,
    "docs/README.md",
    [
      "[Rebase the fork or resolve a patch conflict](./operations/fork-maintenance.md#rebase-the-stack).",
      "[Add or change a fork feature](../.agents/skills/fork-patch-stack/SKILL.md#new-concern-workflow).",
      "[Publish the StGit stack safely](./operations/fork-maintenance.md#publish-the-stack).",
    ].join("\n"),
  );
  write(root, "docs/operations/fork-maintenance.md", "# Fork maintenance\n");
  write(root, "docs/operations/fork-inventory.toml", "schema = 2\n");
  return root;
};

describe("check-fork-docs", () => {
  it("accepts the complete discovery graph and both executable workflows", () => {
    const root = createValidDocs();
    try {
      assert.deepEqual(checkForkDocs(root), []);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REGRESSION: fails when AGENTS no longer routes to LLM_INSTRUCTIONS", () => {
    const root = createValidDocs();
    try {
      write(root, "AGENTS.md", "# Agent guide\n");
      assert.include(checkForkDocs(root).join("\n"), "AGENTS.md must link to LLM_INSTRUCTIONS.md");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REGRESSION: fails when the new-concern workflow is removed", () => {
    const root = createValidDocs();
    try {
      write(
        root,
        ".agents/skills/fork-patch-stack/SKILL.md",
        "---\nname: fork-patch-stack\ndescription: Maintain patches.\n---\n## Rebase workflow\nRun `stg rebase`.\n",
      );
      assert.include(checkForkDocs(root).join("\n"), "new-concern workflow");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REGRESSION: rejects a reintroduced autosquash instruction", () => {
    const root = createValidDocs();
    try {
      NodeFS.appendFileSync(
        NodePath.join(root, "LLM_INSTRUCTIONS.md"),
        "\nRun git rebase --autosquash.\n",
      );
      assert.include(checkForkDocs(root).join("\n"), "stale pre-StGit terminology");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REGRESSION: rejects a local Markdown link to a missing file", () => {
    const root = createValidDocs();
    try {
      NodeFS.appendFileSync(
        NodePath.join(root, "docs/README.md"),
        "\n[Missing](./operations/missing.md)\n",
      );
      assert.include(checkForkDocs(root).join("\n"), "missing local link target");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
