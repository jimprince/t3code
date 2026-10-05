import { GeneralChatInvariantError } from "./GeneralChatError.ts";
// @effect-diagnostics nodeBuiltinImport:off - Preserve shipped environment storage keys.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const getChatProjectStorageKey = (environmentId: string): string =>
  `env-${NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 32)}`;
export const getChatProjectId = (environmentId: string): ProjectId =>
  ProjectId.make(`chat-${getChatProjectStorageKey(environmentId)}`);

/** Stable command receipts and native project locks converge concurrent startup and restarts. */
export const ensureGeneralChat = (environmentId: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const paths = yield* WorkspacePaths.WorkspacePaths;
    const path = yield* Path.Path;
    const projectId = getChatProjectId(environmentId);
    const workspaceRoot = yield* paths.normalizeWorkspaceRoot(
      path.join(NodeOS.tmpdir(), "t3code-chat-workspaces", getChatProjectStorageKey(environmentId)),
      { createIfMissing: true },
    );
    const existing = yield* projects.getById(projectId);
    if (Option.isSome(existing)) {
      if (existing.value.kind !== "chat" || existing.value.workspaceRoot !== workspaceRoot) {
        return yield* Effect.fail(
          new GeneralChatInvariantError({
            message: `Chat project '${projectId}' does not own its server workspace.`,
          }),
        );
      }
      return projectId;
    }
    const project = yield* projects.create({
      projectId,
      commandId: CommandId.make(`chat-project.ensure-${getChatProjectStorageKey(environmentId)}`),
      title: "Chat",
      workspaceRoot,
      kind: "chat",
      createWorkspaceRootIfMissing: true,
    });
    if (project.kind !== "chat" || project.workspaceRoot !== workspaceRoot) {
      return yield* Effect.fail(
        new GeneralChatInvariantError({
          message: `Chat project '${projectId}' was not committed as requested.`,
        }),
      );
    }
    return projectId;
  });

export const ensureChatProject = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  return yield* ensureGeneralChat(String(yield* environment.getEnvironmentId));
});
