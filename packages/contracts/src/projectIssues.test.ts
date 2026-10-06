import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectRequestCreateInput,
  ProjectRequestKind,
  ProjectRequestUpdateInput,
} from "./projectIssues.ts";

const decode = Schema.decodeUnknownSync(ProjectRequestKind);
const decodeCreate = Schema.decodeUnknownSync(ProjectRequestCreateInput);
const decodeUpdate = Schema.decodeUnknownSync(ProjectRequestUpdateInput);

describe("ProjectRequestKind", () => {
  it("accepts the three item types", () => {
    expect(["question", "task", "epic"].map((kind) => decode(kind))).toEqual([
      "question",
      "task",
      "epic",
    ]);
  });

  it("maps an earlier kind from an older client to its successor", () => {
    expect(
      ["bug", "feature", "deliverable", "change", "test", "maintenance", "plan"].map((kind) =>
        decode(kind),
      ),
    ).toEqual(["task", "task", "task", "task", "task", "task", "epic"]);
  });

  it("rejects an unknown kind", () => {
    expect(() => decode("story")).toThrow();
  });

  it("decodes request inputs from an older client and carries the bug flag", () => {
    expect(
      decodeCreate({
        threadId: "t",
        title: "Fix it",
        kind: "bug",
        bug: true,
      }),
    ).toMatchObject({ kind: "task", bug: true });
    expect(
      decodeUpdate({
        threadId: "t",
        reference: "12",
        kind: "plan",
      }),
    ).toMatchObject({ kind: "epic" });
  });
});
