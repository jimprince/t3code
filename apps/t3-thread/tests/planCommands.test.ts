import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { publicationInput } from "../src/planCommands.js";

describe("plan publish command input", () => {
  it("maps an explicitly selected T3 proposal and task-thread option", async () => {
    expect(
      await publicationInput("publisher", {
        title: "Parser",
        owner: "Manager",
        planId: "plan",
        threads: true,
      }),
    ).toEqual({
      threadId: "publisher",
      title: "Parser",
      owner: "Manager",
      createThreads: true,
      source: { type: "proposed_plan", threadId: "publisher", planId: "plan" },
    });
  });
  it("reads approved markdown with its stable publication key", async () => {
    const file = NodePath.join(NodeOS.tmpdir(), `plan-publication-${process.pid}.md`);
    await NodeFSP.writeFile(file, "- Ship parser <!-- task:parser -->\n", "utf8");
    try {
      const result = await publicationInput("publisher", {
        title: "Parser",
        owner: "Manager",
        file,
        key: "parser-v2",
      });
      expect(result.source).toEqual({
        type: "markdown",
        key: "parser-v2",
        markdown: "- Ship parser <!-- task:parser -->",
      });
    } finally {
      await NodeFSP.unlink(file);
    }
  });
  it("rejects missing, ambiguous and unstable sources before reading a file or publishing", async () => {
    const base = { title: "Parser", owner: "Manager" };
    await expect(publicationInput("publisher", base)).rejects.toThrow("exactly one");
    await expect(
      publicationInput("publisher", { ...base, file: "unused", planId: "plan" }),
    ).rejects.toThrow("exactly one");
    await expect(publicationInput("publisher", { ...base, file: "unused" })).rejects.toThrow(
      "--key",
    );
    await expect(
      publicationInput("publisher", { ...base, planId: "plan", key: "unused" }),
    ).rejects.toThrow("only for markdown");
  });
});
