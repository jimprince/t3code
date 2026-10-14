import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { RequestsToolkit } from "./tools.ts";

const decodeAdd = Schema.decodeUnknownSync(RequestsToolkit.tools.request_add.parametersSchema);
const decodeOrder = Schema.decodeUnknownSync(RequestsToolkit.tools.request_order.parametersSchema);

describe("request MCP catalog", () => {
  it("publishes the ordering and typed filing tools with inline inputs and shared presentation", () => {
    expect(Object.keys(RequestsToolkit.tools)).toEqual([
      "request_order",
      "request_queue",
      "request_next",
      "request_add",
    ]);
    for (const tool of Object.values(RequestsToolkit.tools)) {
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      expect(JSON.stringify(schema)).not.toContain('"$ref"');
      expect(resolveT3McpToolDefinition(`mcp__t3-code__${tool.name}`)?.labels).toHaveLength(4);
    }
  });
  it("accepts bug filings, workstream and relative placement without exposing raw numeric ranks", () => {
    const add = decodeAdd({
      title: "  Fix the layout  ",
      kind: "bug",
      partOf: 300,
      place: { to: "after", reference: "#297" },
    });
    expect(add.kind).toBe("bug");
    expect(add.title).toBe("  Fix the layout  ");
    expect(add.place).toEqual({ to: "after", reference: "#297" });
    expect(() =>
      decodeOrder({
        reference: "12",
        place: { to: "rank", rank: 3072 },
      }),
    ).toThrow();
  });
});
