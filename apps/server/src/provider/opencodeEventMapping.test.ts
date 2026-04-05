import { describe, expect, it } from "vitest";

import { toCanonicalRequestType } from "./opencodeEventMapping.ts";

describe("toCanonicalRequestType", () => {
  it("maps read-like OpenCode permission names without a cached tool name", () => {
    expect(toCanonicalRequestType({ permission: "glob" })).toBe("file_read_approval");
    expect(toCanonicalRequestType({ permission: "grep" })).toBe("file_read_approval");
  });

  it("maps file-change OpenCode permission names without a cached tool name", () => {
    expect(toCanonicalRequestType({ permission: "patch" })).toBe("file_change_approval");
    expect(toCanonicalRequestType({ permission: "multiedit" })).toBe("file_change_approval");
    expect(toCanonicalRequestType({ permission: "apply_patch" })).toBe("file_change_approval");
  });
});
