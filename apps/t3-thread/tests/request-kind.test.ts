import { WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { WsRpcGroup } from "../src/contracts.js";

import { requestKindPayload } from "../src/requestKind.js";

describe("requestKindPayload", () => {
  it("sends the current kind, with the bug tag, to a server that has the item types", () => {
    expect(requestKindPayload("task", false, true)).toEqual({ kind: "task" });
    expect(requestKindPayload("task", true, true)).toEqual({ kind: "task", bug: true });
    expect(requestKindPayload("epic", false, true)).toEqual({ kind: "epic" });
  });

  it("files under an earlier kind on a server that predates the item types", () => {
    expect(requestKindPayload("task", false, false)).toEqual({ kind: "change" });
    expect(requestKindPayload("task", true, false)).toEqual({ kind: "bug" });
    expect(requestKindPayload("epic", false, false)).toEqual({ kind: "plan" });
    expect(requestKindPayload("question", false, false)).toEqual({ kind: "question" });
  });
});

const createPayload = WsRpcGroup.requests.get(WS_METHODS.projectRequestsCreate)!.payloadSchema;
const encodeCreate = Schema.encodeUnknownSync(createPayload as Schema.Codec<unknown, unknown>);
const encode = (kind: string) =>
  encodeCreate({ threadId: "thread-1", title: "Do the thing", kind });

describe("request create payload on the wire", () => {
  it("lets an earlier kind through unchanged for an older server", () => {
    expect(encode("change")).toMatchObject({ kind: "change" });
    expect(encode("plan")).toMatchObject({ kind: "plan" });
    expect(encode("task")).toMatchObject({ kind: "task" });
  });

  it("still rejects a kind no server has", () => {
    expect(() => encode("chore")).toThrow();
  });
});
