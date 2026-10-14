import { expect, it } from "vite-plus/test";
import { RemoteEnvironmentClient } from "../src/client.js";
import { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { SavedEnvironment } from "../src/types.js";

const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);

it("refuses resume on an older server whose capability schema omits the optional flag", async () => {
  const capabilities = decodeCapabilities({
    files: true,
    terminal: true,
    git: true,
    providers: true,
    projects: true,
    orchestration: true,
  });
  expect(capabilities.threadResumeFromPlan).toBeUndefined();
  const client = new RemoteEnvironmentClient({} as SavedEnvironment, {
    descriptorFactory: async () => ({ capabilities }) as never,
    rpcFactory: () => {
      throw new Error("Old server RPC must not be called");
    },
  });
  await expect(client.resumePlan("thread", true)).rejects.toThrow(
    "does not support resume from plan",
  );
});
