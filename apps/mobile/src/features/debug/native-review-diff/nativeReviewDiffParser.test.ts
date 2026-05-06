import { describe, expect, it } from "vitest";

import { parseNativeReviewDiffFixture } from "./nativeReviewDiffParser";

describe("parseNativeReviewDiffFixture", () => {
  it("adds word diff ranges to paired changed lines", () => {
    const parsed = parseNativeReviewDiffFixture({
      id: "states",
      label: "States",
      filename: "states.diff",
      lineCount: 9,
      diff: [
        "diff --git a/main.ts b/main.ts",
        "index 1111111..2222222 100644",
        "--- a/main.ts",
        "+++ b/main.ts",
        "@@ -1,3 +1,3 @@",
        " const stable = true;",
        '-const label = "Before value";',
        '+const label = "After value";',
        " const done = true;",
      ].join("\n"),
    });

    const deletion = parsed.rows.find((row) => row.change === "delete");
    const addition = parsed.rows.find((row) => row.change === "add");

    expect(deletion?.wordDiffRanges).toEqual([{ start: 15, end: 21 }]);
    expect(addition?.wordDiffRanges).toEqual([{ start: 15, end: 20 }]);
  });

  it("does not add word diff ranges to unpaired created lines", () => {
    const parsed = parseNativeReviewDiffFixture({
      id: "states",
      label: "States",
      filename: "states.diff",
      lineCount: 9,
      diff: [
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "index 0000000..2222222",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1,2 @@",
        '+const label = "After value";',
        "+export default label;",
      ].join("\n"),
    });

    expect(parsed.rows.filter((row) => row.kind === "line")).toHaveLength(2);
    expect(parsed.rows.every((row) => row.wordDiffRanges === undefined)).toBe(true);
  });

  it("trims whitespace from word diff range edges", () => {
    const parsed = parseNativeReviewDiffFixture({
      id: "states",
      label: "States",
      filename: "states.diff",
      lineCount: 8,
      diff: [
        "diff --git a/main.tsx b/main.tsx",
        "index 1111111..2222222 100644",
        "--- a/main.tsx",
        "+++ b/main.tsx",
        "@@ -1,2 +1,2 @@",
        "-    const status = disabled;",
        "+    const status = enabled;",
      ].join("\n"),
    });

    const deletion = parsed.rows.find((row) => row.change === "delete");
    const addition = parsed.rows.find((row) => row.change === "add");

    expect(deletion?.wordDiffRanges?.[0]?.start).toBeGreaterThanOrEqual(4);
    expect(addition?.wordDiffRanges?.[0]?.start).toBeGreaterThanOrEqual(4);
  });

  it("keeps word diff ranges aligned to exact replacement columns", () => {
    const parsed = parseNativeReviewDiffFixture({
      id: "states",
      label: "States",
      filename: "states.diff",
      lineCount: 12,
      diff: [
        "diff --git a/main.ts b/main.ts",
        "index 1111111..2222222 100644",
        "--- a/main.ts",
        "+++ b/main.ts",
        "@@ -1,5 +1,5 @@",
        "-const retryLimit = 2;",
        "+const retryLimit = 4;",
        '-const greeting = greeting.replace("{name}", "reviewer");',
        '+const greeting = greeting.replace("{name}", "native reviewer");',
      ].join("\n"),
    });

    const changedRows = parsed.rows.filter((row) => row.kind === "line");

    expect(changedRows[0]?.wordDiffRanges).toEqual([{ start: 19, end: 20 }]);
    expect(changedRows[1]?.wordDiffRanges).toEqual([{ start: 19, end: 20 }]);
    expect(changedRows[2]?.wordDiffRanges).toBeUndefined();
    expect(changedRows[3]?.wordDiffRanges).toEqual([{ start: 45, end: 51 }]);
  });

  it("suppresses noisy word diff ranges for unrelated replacement lines", () => {
    const parsed = parseNativeReviewDiffFixture({
      id: "states",
      label: "States",
      filename: "states.diff",
      lineCount: 8,
      diff: [
        "diff --git a/main.tsx b/main.tsx",
        "index 1111111..2222222 100644",
        "--- a/main.tsx",
        "+++ b/main.tsx",
        "@@ -1,2 +1,2 @@",
        '-    case "file-header":',
        "+    const status = enabled;",
      ].join("\n"),
    });

    expect(parsed.rows.every((row) => row.wordDiffRanges === undefined)).toBe(true);
  });

  it("adds notice rows for pure renames and metadata-only changes", () => {
    const parsed = parseNativeReviewDiffFixture({
      id: "states",
      label: "States",
      filename: "states.diff",
      lineCount: 16,
      diff: [
        "diff --git a/src/oldName.ts b/src/newName.ts",
        "similarity index 100%",
        "rename from src/oldName.ts",
        "rename to src/newName.ts",
        "diff --git a/scripts/run.sh b/scripts/run.sh",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/assets/logo.png b/assets/logo.png",
        "new file mode 100644",
        "index 000000000..4628f44da",
        "--- /dev/null",
        "+++ b/assets/logo.png",
        "Binary files /dev/null and b/assets/logo.png differ",
      ].join("\n"),
    });

    const noticeTexts = parsed.rows.filter((row) => row.kind === "notice").map((row) => row.text);

    expect(noticeTexts).toEqual([
      "This file was renamed without modifications.",
      "File mode changed from 100644 to 100755.",
      "Unsupported binary format. Diff contents are not available.",
    ]);
  });
});
