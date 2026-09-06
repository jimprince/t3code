// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CursorSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);

class CursorAdapter extends Context.Service<CursorAdapter, CursorAdapterShape>()(
  "t3/provider/Layers/CursorAdapter.fork.test/CursorAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

/** Records the agent process's own `T3_THREAD_ID` before handing off to the mock agent. */
async function makeThreadIdRecordingWrapper(dir: string, recordPath: string) {
  const wrapperPath = NodePath.join(dir, "fake-agent.sh");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh
printf '%s\\n' "\${T3_THREAD_ID:-<unset>}" >> ${JSON.stringify(recordPath)}
exec node ${JSON.stringify(mockAgentPath)} "$@"
`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const makeResolveCursorSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return serverSettings.getSettings.pipe(
    Effect.map((snapshot) => snapshot.providers.cursor),
    Effect.orDie,
  );
});

const cursorAdapterTestLayer = it.layer(
  Layer.effect(
    CursorAdapter,
    Effect.gen(function* () {
      const resolveSettings = yield* makeResolveCursorSettings;
      return yield* makeCursorAdapter(decodeCursorSettings({}), { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-cursor-adapter-fork-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

cursorAdapterTestLayer("CursorAdapterLive thread identity", (it) => {
  // Regression: ACP agents inherited only the server's process-wide
  // T3_ENVIRONMENT_* metadata, so `t3-thread` inside the session could not
  // resolve which thread it was running as.
  it.effect("spawns the ACP agent with T3_THREAD_ID", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-identity-thread");

      const recordDir = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-identity-")),
        ),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const recordPath = NodePath.join(recordDir, "thread-id.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeThreadIdRecordingWrapper(recordDir, recordPath),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      // ACP startup acknowledges initialization after the wrapper writes the file.
      const recordedIdentity = yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8"));
      assert.equal(recordedIdentity.trim(), threadId);
    }).pipe(Effect.scoped),
  );
});
