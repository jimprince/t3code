// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

const METHOD = "skills/extraRoots/set";

/** Resolve once before spawning; roots belong to the server, never the thread cwd. */
export const resolveCodexSkillExtraRoots = Effect.fn("resolveCodexSkillExtraRoots")(function* (
  roots: ReadonlyArray<string> = [],
) {
  const home = yield* HostProcess.HomeDirectory;
  return yield* Effect.forEach(roots, (root) => {
    const expanded = expandHomePath(root, home);
    return NodePath.isAbsolute(expanded)
      ? Effect.succeed(expanded)
      : Effect.fail(
          CodexErrors.CodexAppServerRequestError.invalidParams(
            "Codex skill extra roots must be absolute paths or start with ~/.",
            undefined,
            { method: METHOD },
          ),
        );
  });
});

/** Apply this process's scope after the initialize handshake, before any skill consumer. */
export const applyCodexSkillExtraRoots = Effect.fn("applyCodexSkillExtraRoots")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  extraRoots: ReadonlyArray<string>,
) {
  if (extraRoots.length === 0) return "not-configured" as const;
  return yield* client.request(METHOD, { extraRoots }).pipe(
    Effect.as("applied" as const),
    Effect.catchTags({
      CodexAppServerRequestError: (error) =>
        error.code === -32601
          ? Effect.logWarning(
              "Codex does not support extra skill roots; configured roots were not applied.",
              {
                method: METHOD,
              },
            ).pipe(Effect.as("unsupported" as const))
          : Effect.fail(error),
    }),
  );
});
