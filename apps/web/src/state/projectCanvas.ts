import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The orchestrator's canvas pages, re-read every 30 seconds while shown. */
export const projectCanvasQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-canvas:read",
  tag: WS_METHODS.projectCanvasRead,
  staleTimeMs: 15_000,
  refreshIntervalMs: 30_000,
  idleTtlMs: 0,
});

/** Logs a canvas intent and its outcome on the server, so canvas actions are auditable. */
export const logProjectCanvasAction = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-canvas:action",
  tag: WS_METHODS.projectCanvasAction,
});
