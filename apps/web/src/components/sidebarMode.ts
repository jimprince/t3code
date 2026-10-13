import * as Schema from "effect/Schema";

import { useLocalStorage } from "../hooks/useLocalStorage";

export const SIDEBAR_MODE_SCHEMA = Schema.Literals(["threads", "orchestrators", "harness"]);

/** Which list the sidebar shows (Threads, Projects, Harness), remembered per device. */
export function useSidebarMode() {
  return useLocalStorage("t3code:sidebar:mode", "threads" as const, SIDEBAR_MODE_SCHEMA);
}
