import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { projectReturnState } from "./projectNavigation";

describe("project navigation", () => {
  it("records only the project page that opened a thread", () => {
    expect(
      projectReturnState({
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("root-1"),
      }),
    ).toEqual({
      projectReturn: { environmentId: "env-1", threadId: "root-1" },
    });
  });
});
