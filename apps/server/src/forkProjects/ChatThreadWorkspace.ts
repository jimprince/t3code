import { GeneralChatInvariantError } from "./GeneralChatError.ts";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";

/** Apply the same workspace guard to native thread commands, regardless of transport. */
export const validateChatThreadWorkspace = (
  projects: ProjectStoreV2["Service"],
  projectId: ProjectId,
  worktreePath: string | null | undefined,
) =>
  Effect.gen(function* () {
    if (worktreePath == null) return;
    const project = yield* projects.get(projectId);
    if (Option.isSome(project) && project.value.kind === "chat") {
      return yield* new GeneralChatInvariantError({
        message: "General Chat cannot override its server workspace.",
      });
    }
  });
