import { expect, it } from "vite-plus/test";
import { RPC_METHODS } from "../src/rpc.js";
import { WsRpcGroup } from "../src/contracts.js";

it("every operator method has a registered wire RPC for the generated client", () => {
  const missing = Object.entries(RPC_METHODS).filter(([, wire]) => !WsRpcGroup.requests.has(wire));
  expect(missing).toEqual([]);
});

it("task-linked create uses a native launch method registered by the narrow group", () => {
  expect(RPC_METHODS.launchThread).toBe("orchestration.launchThread");
  expect(WsRpcGroup.requests.has(RPC_METHODS.launchThread)).toBe(true);
});
