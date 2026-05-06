import { describe, expect, it } from "vitest";

import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "./reviewModel";

describe("buildNativeReviewDiffData", () => {
  it("maps real parsed file diffs into native rows with headers, hunks, lines, and notices", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/demo/src/main.ts b/apps/demo/src/main.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/demo/src/main.ts",
        "+++ b/apps/demo/src/main.ts",
        "@@ -1,2 +1,2 @@",
        "-const retryLimit = 2;",
        "+const retryLimit = 4;",
        " console.log(retryLimit);",
        "diff --git a/apps/demo/src/old.ts b/apps/demo/src/new.ts",
        "similarity index 100%",
        "rename from apps/demo/src/old.ts",
        "rename to apps/demo/src/new.ts",
        "diff --git a/apps/demo/assets/review-logo.png b/apps/demo/assets/review-logo.png",
        "new file mode 100644",
        "index 0000000..1111111",
        "Binary files /dev/null and b/apps/demo/assets/review-logo.png differ",
      ].join("\n"),
      "native-adapter-test",
    );

    const data = buildNativeReviewDiffData(parsed);

    expect(data.additions).toBe(1);
    expect(data.deletions).toBe(1);
    expect(data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "apps/demo/src/main.ts",
          language: "typescript",
          additions: 1,
          deletions: 1,
        }),
        expect.objectContaining({
          path: "apps/demo/src/new.ts",
          language: "typescript",
          additions: 0,
          deletions: 0,
        }),
      ]),
    );
    expect(data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          filePath: "apps/demo/src/main.ts",
          changeType: "modified",
        }),
        expect.objectContaining({
          kind: "hunk",
          text: "@@ -1,2 +1,2 @@",
        }),
        expect.objectContaining({
          kind: "line",
          change: "delete",
          content: "const retryLimit = 2;",
          wordDiffRanges: [{ start: 19, end: 20 }],
        }),
        expect.objectContaining({
          kind: "line",
          change: "add",
          content: "const retryLimit = 4;",
          wordDiffRanges: [{ start: 19, end: 20 }],
        }),
        expect.objectContaining({
          kind: "file",
          filePath: "apps/demo/src/new.ts",
          previousPath: "apps/demo/src/old.ts",
          changeType: "rename-pure",
        }),
        expect.objectContaining({
          kind: "notice",
          text: "This file was renamed without modifications.",
        }),
        expect.objectContaining({
          kind: "notice",
          text: "Unsupported format. Diff contents are not available.",
        }),
      ]),
    );
  });
});
