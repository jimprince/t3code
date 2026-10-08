import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { RpcServer, RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WsForkRpcGroup,
  WsCoreRpcGroup,
} from "@t3tools/contracts";
import { rpcScopeAuthorizationLayer } from "./auth/RpcAuthorization.ts";
import { makeGiteaTokenRpcHandler } from "./sourceControl/GiteaTokenRpc.ts";
// @effect-diagnostics nodeBuiltinImport:off
// Loopback fake Gitea exercises the real FetchHttpClient transport.
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as Queue from "effect/Queue";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ThreadId, WsRpcGroup, type GiteaTokenSetResult } from "@t3tools/contracts";
import { installGiteaToken, GiteaTokenCliError } from "../../t3-thread/src/giteaTokenCore.ts";
import * as Gitea from "./sourceControl/GiteaSourceControlProvider.ts";
import * as Issues from "./projectIssues/ProjectIssuesService.ts";
import * as Discovery from "./sourceControl/SourceControlDiscovery.ts";
import * as Registry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as Metadata from "./forkThreads/MetadataStore.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Engine from "./orchestration-v2/ThreadManagementService.ts";
import { probeSourceControlProvider } from "./sourceControl/SourceControlProviderDiscovery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import { GiteaTokenSetInput, GITEA_TOKEN_REDACTED, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as Settings from "./serverSettings.ts";
import * as Config from "./config.ts";
import * as Secrets from "./auth/ServerSecretStore.ts";
import { giteaTokenSecretName } from "./sourceControl/giteaSettings.ts";
import { observeRpcEffect } from "./observability/RpcInstrumentation.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sentinel = "synthetic-id3-test-only";
const input = (id = "home") =>
  Schema.decodeUnknownSync(GiteaTokenSetInput)({ instanceId: id, token: sentinel });
const instance = {
  id: "home",
  host: "git.home",
  sshAliases: ["git-alias"],
  sshPorts: [2222],
  webOrigin: "http://git.home:3000",
  apiOrigin: "http://api.home:3000",
  token: "synthetic-old",
};
const layer = (wrap: (fs: FileSystem.FileSystem) => FileSystem.FileSystem = (fs) => fs) => {
  const filesystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, wrap),
  ).pipe(Layer.provide(NodeServices.layer));
  const config = Config.layerTest(process.cwd(), { prefix: "t3-gitea-setter-" }).pipe(
    Layer.provideMerge(filesystem),
  );
  const secrets = Secrets.layer.pipe(Layer.provideMerge(config));
  return Settings.layer.pipe(
    Layer.provideMerge(secrets),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
  );
};
const denied = () =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: "synthetic",
    description: sentinel,
  });

it.layer(NodeServices.layer)("atomic existing-ID Gitea token setter", (it) => {
  it.effect("preserves instance identity, order, settings and other secrets", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const secrets = yield* Secrets.ServerSecretStore;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      yield* secrets.set("unrelated", new TextEncoder().encode("synthetic-unrelated"));
      yield* settings.updateSettings({
        giteaInstances: [
          instance,
          {
            ...instance,
            id: "other",
            host: "git.other",
            webOrigin: "http://git.other",
            apiOrigin: "http://api.other",
            token: "synthetic-other",
          },
        ],
        settledSubthreadArchiveAfterDays: 17,
      });
      const before = yield* settings.getSettings;
      assert.deepEqual(yield* settings.setGiteaToken(input()), {
        instanceId: "home",
        tokenSet: true,
        storedMatchesInput: true,
      });
      const after = yield* settings.getSettings;
      assert.deepEqual(after, {
        ...before,
        giteaInstances: before.giteaInstances.map((value) =>
          value.id === "home" ? { ...value, token: sentinel } : value,
        ),
      });
      assert.strictEqual(
        new TextDecoder().decode(Option.getOrThrow(yield* secrets.get("unrelated"))),
        "synthetic-unrelated",
      );
      assert.notInclude(yield* fs.readFileString(config.settingsPath), sentinel);
      const client = Settings.redactServerSettingsForClient(after);
      assert.strictEqual(client.giteaInstances[0]?.token, GITEA_TOKEN_REDACTED);
      const restarted = yield* Settings.ServerSettingsService.pipe(
        Effect.provide(Layer.fresh(Settings.layer)),
      );
      assert.strictEqual((yield* restarted.getSettings).giteaInstances[0]?.token, sentinel);
      assert.strictEqual(
        (yield* restarted.getSettings).giteaInstances[1]?.token,
        "synthetic-other",
      );
      const unknown = yield* Effect.flip(settings.setGiteaToken(input("absent")));
      assert.strictEqual(unknown.reason, "unknown-instance");
      assert.deepEqual(yield* settings.getSettings, after);
      assert.isFalse(
        yield* fs.exists(`${config.secretsDir}/${giteaTokenSecretName("absent")}.bin`),
      );
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each(["edit", "delete"] as const)(
    "serializes a concurrent %s before token lookup",
    (operation) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let block = false;
        const testLayer = layer((fs) => ({
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (block && String(to).endsWith("settings.json")) {
                block = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              yield* fs.rename(from, to);
            }),
        }));
        yield* Effect.gen(function* () {
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({ giteaInstances: [instance] });
          block = true;
          const edit = yield* Effect.forkScoped(
            settings.updateSettings({
              giteaInstances:
                operation === "delete"
                  ? []
                  : [{ ...instance, token: GITEA_TOKEN_REDACTED, sshAliases: ["concurrent-edit"] }],
              settledSubthreadArchiveAfterDays: 19,
            }),
          );
          yield* Deferred.await(entered);
          const setter = yield* Effect.forkScoped(Effect.result(settings.setGiteaToken(input())));
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(edit);
          const result = yield* Fiber.join(setter);
          const current = yield* settings.getSettings;
          assert.strictEqual(current.settledSubthreadArchiveAfterDays, 19);
          if (operation === "delete") {
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.strictEqual(result.failure.reason, "unknown-instance");
            assert.deepEqual(current.giteaInstances, []);
          } else {
            assert.strictEqual(result._tag, "Success");
            assert.deepEqual(current.giteaInstances[0]?.sshAliases, ["concurrent-edit"]);
            assert.strictEqual(current.giteaInstances[0]?.token, sentinel);
          }
        }).pipe(Effect.provide(testLayer));
      }),
  );

  it.effect.each(["settings", "secret"] as const)(
    "rolls back %s commit changes and redacts errors and child traces",
    (failure) => {
      let fail = false;
      const testLayer = layer((fs) => ({
        ...fs,
        rename: (from, to) =>
          Effect.gen(function* () {
            if (fail && failure === "settings" && String(to).endsWith("settings.json"))
              return yield* Effect.fail(denied());
            yield* fs.rename(from, to);
            if (fail && failure === "secret" && String(to).endsWith(".bin")) {
              fail = false; // Rollback can restore the write that occurred before this error.
              return yield* Effect.fail(denied());
            }
          }),
      }));
      return Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({ giteaInstances: [instance] });
        const before = yield* settings.getSettings;
        const spans: string[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              spans.push(
                encodeJson({ name: span.name, attributes: Array.from(span.attributes), exit }),
              );
              end(time, exit);
            };
            return span;
          },
        });
        fail = true;
        const error = yield* Effect.flip(
          observeRpcEffect(WS_METHODS.giteaSetToken, settings.setGiteaToken(input())).pipe(
            Effect.withSpan("token-rpc"),
            Effect.withTracer(tracer),
          ),
        );
        assert.notInclude(encodeJson(error), sentinel);
        assert.strictEqual(error.reason, "storage-failed");
        assert.notInclude(spans.join("\n"), sentinel);
        assert.isTrue(spans.length > 0);
        assert.deepEqual(yield* settings.getSettings, before);
        const secrets = yield* Secrets.ServerSecretStore;
        assert.strictEqual(
          new TextDecoder().decode(
            Option.getOrThrow(yield* secrets.get(giteaTokenSecretName("home"))),
          ),
          instance.token,
        );
      }).pipe(Effect.provide(testLayer));
    },
  );

  it.effect("creates secret files with mode 0600 before any bytes", () => {
    let observed = 0;
    const testLayer = layer((fs) => ({
      ...fs,
      open: (path, options) =>
        fs.open(path, options).pipe(
          Effect.map(
            (file) =>
              new Proxy(file, {
                get: (target, key) =>
                  key === "writeAll"
                    ? (bytes: Uint8Array) =>
                        Effect.gen(function* () {
                          const stat = yield* fs.stat(path);
                          assert.strictEqual(stat.mode & 0o777, 0o600);
                          assert.strictEqual(Number(stat.size), 0);
                          observed++;
                          yield* file.writeAll(bytes);
                        })
                    : Reflect.get(target, key),
              }),
          ),
        ),
    }));
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ giteaInstances: [{ ...instance, token: "" }] });
      yield* settings.setGiteaToken(input());
      assert.strictEqual(observed, 1);
    }).pipe(Effect.provide(testLayer));
  });
});

it.layer(NodeServices.layer)("Gitea stdin installation integration", (it) => {
  it.effect.each([false, true])(
    "stdin -> production store -> uncached /user -> native issue read (lost acknowledgement=%s)",
    (lostAck) =>
      Effect.gen(function* () {
        const calls: Array<{ path: string; newToken: boolean }> = [];
        const fake = NodeHttp.createServer((request, response) => {
          const path = request.url ?? "";
          const newToken = request.headers.authorization === `token ${sentinel}`;
          calls.push({ path, newToken });
          const authenticated =
            newToken || request.headers.authorization === `token ${instance.token}`;
          response.writeHead(authenticated ? 200 : 401, { "content-type": "application/json" });
          const issue = {
            number: 74,
            title: "Synthetic native issue",
            body: "test body",
            state: "open",
            html_url: "http://git.fake/brad/repo/issues/74",
            created_at: "2026-10-06T00:00:00Z",
            updated_at: "2026-10-06T00:00:00Z",
          };
          response.end(
            encodeJson(
              path === "/api/v1/user"
                ? { login: "synthetic-owner" }
                : path === "/api/v1/repos/brad/repo/issues/74"
                  ? issue
                  : [],
            ),
          );
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () => new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve)),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  fake.closeAllConnections();
                  fake.close(() => resolve());
                }),
            ),
        );
        const address = fake.address();
        if (!address || typeof address === "string")
          return yield* Effect.die("Expected loopback server");
        const origin = `http://127.0.0.1:${address.port}`;
        yield* Effect.gen(function* () {
          const settings = yield* Settings.ServerSettingsService;
          const config = yield* Config.ServerConfig;
          yield* settings.updateSettings({
            giteaInstances: [
              {
                ...instance,
                host: "127.0.0.1",
                webOrigin: origin,
                apiOrigin: origin,
                sshAliases: [],
              },
            ],
          });
          const gitea = yield* Gitea.make;
          const process = yield* VcsProcess.VcsProcess;
          const providerDiscovery = probeSourceControlProvider({
            spec: gitea.discovery,
            process,
            cwd: config.cwd,
          });
          const discovery = yield* Discovery.make.pipe(
            Effect.provide(
              Layer.mock(Registry.SourceControlProviderRegistry)({
                discover: Effect.map(providerDiscovery, (value) => [value]),
                resolveLink: () => undefined,
              }),
            ),
          );
          yield* Metadata.initializeMetadata(yield* SqlClient.SqlClient);
          const issues = yield* Issues.make;
          yield* discovery.discover; // Warm the same discovery service before replacing the credential.
          const baseline = calls.length;
          const queue = yield* Queue.unbounded<Effect.Effect<void>>();
          yield* Effect.forkScoped(
            Effect.forever(Effect.flatMap(Queue.take(queue), (work) => work)),
          );
          const receipts: GiteaTokenSetResult[] = [];
          let mutations = 0;
          const dependencies: Parameters<typeof installGiteaToken>[1] = {
            stdin: NodeStream.Readable.from([sentinel + "\n"]),
            environment: {},
            print: (value) => receipts.push(value),
            client: async () => ({
              withGiteaTokenRpc: async (run) =>
                run({
                  request: <T>(method: string, payload: unknown) =>
                    new Promise<T>((resolve, reject) => {
                      const tag = {
                        serverGetSettings: WS_METHODS.serverGetSettings,
                        giteaSetToken: WS_METHODS.giteaSetToken,
                        serverDiscoverSourceControl: WS_METHODS.serverDiscoverSourceControl,
                        projectIssuesGet: WS_METHODS.projectIssuesGet,
                      }[method];
                      const rpc = tag && WsRpcGroup.requests.get(tag);
                      if (!rpc) {
                        reject(new Error("Unexpected method"));
                        return;
                      }
                      // Use the production JSON payload/result codecs across the asynchronous boundary.
                      const payloadCodec = Schema.toCodecJson(rpc.payloadSchema);
                      const wire = Schema.encodeSync(payloadCodec)(payload as never);
                      const work = Effect.gen(function* () {
                        const decoded = yield* Schema.decodeUnknownEffect(payloadCodec)(wire);
                        if (method === "giteaSetToken") mutations++;
                        const result = yield* method === "serverGetSettings"
                          ? Effect.map(settings.getSettings, Settings.redactServerSettingsForClient)
                          : method === "giteaSetToken"
                            ? observeRpcEffect(
                                WS_METHODS.giteaSetToken,
                                settings.setGiteaToken(decoded as GiteaTokenSetInput),
                              )
                            : method === "serverDiscoverSourceControl"
                              ? discovery.discover
                              : issues.get(decoded as Parameters<typeof issues.get>[0]);
                        if (lostAck && method === "giteaSetToken") {
                          reject(new Error(sentinel));
                          return;
                        }
                        const codec = Schema.toCodecJson(rpc.successSchema);
                        const encoded = yield* Schema.encodeEffect(codec)(result as never);
                        resolve((yield* Schema.decodeUnknownEffect(codec)(encoded)) as T);
                      }).pipe(
                        Effect.catchCause(() => Effect.sync(() => reject(new Error("RPC failed")))),
                      );
                      Queue.offerUnsafe(queue, work);
                    }),
                }),
            }),
          };
          const consumer = Effect.tryPromise({
            try: () =>
              installGiteaToken(
                {
                  env: "fake",
                  instance: "home",
                  tokenStdin: true,
                  rootThread: "root",
                  repository: "brad/repo",
                  issue: "74",
                },
                dependencies,
              ),
            catch: (error) =>
              error instanceof GiteaTokenCliError ? error : new GiteaTokenCliError(30),
          });
          if (lostAck) {
            const error = yield* Effect.flip(consumer);
            assert.strictEqual(error.exitCode, 30);
            assert.notInclude(encodeJson(error), sentinel);
            assert.strictEqual(mutations, 1);
            assert.strictEqual((yield* settings.getSettings).giteaInstances[0]?.token, sentinel);
            assert.deepEqual(receipts, []);
            assert.strictEqual(calls.length, baseline);
            return;
          }
          yield* consumer;
          assert.strictEqual(mutations, 1);
          assert.deepEqual(receipts, [
            { instanceId: "home", tokenSet: true, storedMatchesInput: true },
          ]);
          const fresh = calls.slice(baseline);
          assert.strictEqual(fresh.filter((call) => call.path === "/api/v1/user").length, 1);
          assert.isTrue(fresh.some((call) => call.path === "/api/v1/repos/brad/repo/issues/74"));
          assert.isTrue(fresh.every((call) => call.newToken));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layer(),
              FetchHttpClient.layer,
              Layer.mock(VcsProcess.VcsProcess)({
                run: () =>
                  Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "synthetic-version",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
              }),
              Layer.mock(Engine.ThreadManagementService)({
                getShellSnapshot: () =>
                  Effect.succeed({
                    threads: [{ id: ThreadId.make("root"), projectId: "project", issues: [] }],
                    archivedThreads: [],
                  } as never),
              }),
              Layer.mock(ProjectService.ProjectService)({
                listShells: () =>
                  Effect.succeed([
                    {
                      id: "project",
                      workspaceRoot: "/repo",
                      repositoryIdentity: {
                        provider: "gitea",
                        canonicalKey: "127.0.0.1/brad/repo",
                        locator: { remoteUrl: `http://127.0.0.1:${address.port}/brad/repo.git` },
                      },
                    },
                  ] as never),
              }),
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );
});

describe("fork Gitea token WebSocket transport", () => {
  const tag = WS_METHODS.giteaSetToken;
  const group = WsForkRpcGroup.omit(
    ...[...WsForkRpcGroup.requests.keys()].filter(
      (method): method is Exclude<RpcGroup.Rpcs<typeof WsForkRpcGroup>["_tag"], typeof tag> =>
        method !== tag,
    ),
  );
  it.live.each([true, false])(
    "uses redacted fork RPC and rejects read-only authorization (operate=%s)",
    (operate) =>
      Effect.gen(function* () {
        assert.isFalse(WsCoreRpcGroup.requests.has(tag as never));
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({ giteaInstances: [instance] });
        const server = RpcServer.layerHttp({ group, path: "/rpc", protocol: "websocket" }).pipe(
          Layer.provide(group.toLayerHandler(tag, makeGiteaTokenRpcHandler(settings))),
          Layer.provide(
            rpcScopeAuthorizationLayer([
              operate ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
            ]),
          ),
          Layer.provide(RpcSerialization.layerJson),
        );
        const context = yield* Layer.build(
          HttpRouter.serve(server, { disableListenLog: true }).pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
          ),
        );
        const address = Context.get(context, HttpServer.HttpServer).address;
        assert.notStrictEqual(address._tag, "UnixPathAddress");
        if (address._tag === "UnixPathAddress") return;
        const protocol = RpcClient.layerProtocolSocket().pipe(
          Layer.provide(RpcSerialization.layerJson),
          Layer.provide(
            Socket.layerWebSocket(`ws://127.0.0.1:${address.port}/rpc`).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructorWS),
            ),
          ),
        );
        yield* RpcClient.make(group).pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              if (!operate) {
                const denied = yield* client[tag](input()).pipe(Effect.flip);
                assert.strictEqual(denied._tag, "EnvironmentAuthorizationError");
                assert.strictEqual(
                  (yield* settings.getSettings).giteaInstances[0]?.token,
                  instance.token,
                );
                return;
              }
              const receipt = yield* client[tag](input());
              assert.deepEqual(receipt, {
                instanceId: "home",
                tokenSet: true,
                storedMatchesInput: true,
              });
              assert.strictEqual((yield* settings.getSettings).giteaInstances[0]?.token, sentinel);
              const rejected = yield* client[tag](input("absent")).pipe(Effect.flip);
              assert.strictEqual(rejected._tag, "GiteaTokenSetError");
              assert.notInclude(String(rejected), sentinel);
            }),
          ),
          Effect.provide(protocol),
        );
      }).pipe(Effect.provide(layer().pipe(Layer.provideMerge(NodeServices.layer))), Effect.scoped),
  );
});
