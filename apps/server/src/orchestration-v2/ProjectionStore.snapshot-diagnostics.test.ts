import * as Schema from "effect/Schema";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  ServerTraceDiagnosticsResult,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import {
  RpcInstrumentation,
  rpcInstrumentationLayer,
} from "../observability/RpcInstrumentation.ts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Diagnostics from "../diagnostics/ShellSnapshotDiagnostics.ts";
import * as Traces from "../diagnostics/TraceDiagnostics.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projections from "./ProjectionStore.ts";

const encodeDiagnostics = Schema.encodeEffect(ServerTraceDiagnosticsResult);
const decodeDiagnostics = Schema.decodeEffect(ServerTraceDiagnosticsResult);

it.effect.each(["0", "1"])(
  "attributes actual builds and readable diagnostics with cache=%s",
  (cache) =>
    Effect.gen(function* () {
      const store = yield* Projections.ProjectionStoreV2;
      const traces = yield* Traces.TraceDiagnostics;
      yield* store
        .getShellSnapshot()
        .pipe(Effect.provideService(Diagnostics.ShellSnapshotCaller, "dashboard"));
      yield* store
        .getShellSnapshot()
        .pipe(Effect.provideService(Diagnostics.ShellSnapshotCaller, "dashboard"));
      yield* store
        .getShellSnapshot({ location: "archive" })
        .pipe(Effect.provideService(Diagnostics.ShellSnapshotCaller, "cleanup"));
      const result = yield* traces.read({
        traceFilePath: "/missing-test-trace.ndjson",
        maxFiles: 0,
      });
      expect(result.shellSnapshotBuilds).toEqual({
        dashboard: {
          requests: 2,
          fullBuilds: cache === "0" ? 2 : 1,
          cacheHits: cache === "0" ? 0 : 1,
        },
        cleanup: { requests: 1, fullBuilds: cache === "0" ? 1 : 0, cacheHits: 0 },
      });
      const again = yield* traces.read({
        traceFilePath: "/missing-test-trace.ndjson",
        maxFiles: 0,
      });
      expect(again.shellSnapshotBuilds).toEqual(result.shellSnapshotBuilds);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Projections.layer.pipe(Layer.provide(Sqlite.layerMemory)),
          Traces.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
        ).pipe(Layer.provideMerge(Diagnostics.layer)),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ T3CODE_SHELL_SNAPSHOT_CACHE: cache }),
      ),
    ),
);

it.effect("retains the RPC caller through nested service labels", () =>
  Effect.gen(function* () {
    const store = yield* Projections.ProjectionStoreV2;
    const traces = yield* Traces.TraceDiagnostics;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverProbe | typeof WS_METHODS.serverGetTraceDiagnostics
        > => tag !== WS_METHODS.serverProbe && tag !== WS_METHODS.serverGetTraceDiagnostics,
      ),
    ).middleware(RpcInstrumentation);
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverProbe, () =>
            store
              .getShellSnapshot()
              .pipe(Effect.orDie, Diagnostics.withCaller("InternalProbe"), Effect.as({})),
          ),
          group.toLayerHandler(WS_METHODS.serverGetTraceDiagnostics, () =>
            traces.read({ traceFilePath: "/missing-test-trace.ndjson", maxFiles: 0 }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope, AuthDiagnosticsReadScope]),
          rpcInstrumentationLayer,
        ),
      ),
    );
    yield* client[WS_METHODS.serverProbe]({});
    const result = yield* client[WS_METHODS.serverGetTraceDiagnostics]({});
    expect(result.shellSnapshotBuilds).toEqual({
      [WS_METHODS.serverProbe]: { requests: 1, fullBuilds: 1, cacheHits: 0 },
    });
    const wire = yield* encodeDiagnostics(result);
    const decoded = yield* decodeDiagnostics(wire);
    expect(decoded.shellSnapshotBuilds).toEqual(result.shellSnapshotBuilds);
    const legacy = { ...wire };
    delete legacy.shellSnapshotBuilds;
    const olderResult = yield* decodeDiagnostics(legacy);
    expect(olderResult.shellSnapshotBuilds).toBeUndefined();
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Projections.layer.pipe(Layer.provide(Sqlite.layerMemory)),
        Traces.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
      ).pipe(Layer.provideMerge(Diagnostics.layer)),
    ),
  ),
);
