// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { checkCodexProviderStatus, probeCodexSkillsForCwd } from "./Layers/CodexProvider.ts";
import { CodexSettings } from "@t3tools/contracts";
import wireFixture from "./testFixtures/codexMultiAgentWire.json" with { type: "json" };

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

const roots = [
  NodePath.join(NodeOS.tmpdir(), "skills-B"),
  NodePath.join(NodeOS.tmpdir(), "skills-A"),
];
const cwd = NodeOS.tmpdir();
const skills = [
  {
    name: "review",
    path: `${roots[0]}/review/SKILL.md`,
    description: "B",
    scope: "user",
    enabled: true,
  },
  {
    name: "review",
    path: `${roots[1]}/review/SKILL.md`,
    description: "A",
    scope: "user",
    enabled: true,
  },
  {
    name: "review",
    path: `${roots[0]}/review/SKILL.md`,
    description: "duplicate",
    scope: "user",
    enabled: true,
  },
];
const decodeMessage = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
      params: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    }),
  ),
);

/** A separate stateful stdio peer per spawn, used by the real typed client and launchers. */
function makePeer(failure?: number | "exit", nativeChild = false) {
  const processes: Array<{
    methods: string[];
    configured: boolean;
    closed: boolean;
    command: ChildProcess.StandardCommand;
  }> = [];
  const closers: Array<Effect.Effect<void>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      const peer = { methods: [] as string[], configured: false, closed: false, command };
      processes.push(peer);
      const output = yield* Queue.unbounded<string, Cause.Done<void>>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      closers.push(
        Queue.end(output).pipe(
          Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
          Effect.asVoid,
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          peer.closed = true;
        }),
      );
      const respond = (message: unknown) => Queue.offer(output, `${JSON.stringify(message)}\n`);
      const stdin = Sink.forEach((bytes: Uint8Array) =>
        Effect.gen(function* () {
          for (const line of new TextDecoder().decode(bytes).split("\n").filter(Boolean)) {
            const message = decodeMessage(line);
            const { id, method, params } = message;
            peer.methods.push(method);
            if (method === "initialized") continue;
            if (method === "initialize") {
              yield* respond({
                id,
                result: {
                  userAgent: "test/0.160.0",
                  codexHome: cwd,
                  platformFamily: "unix",
                  platformOs: "linux",
                },
              });
            } else if (method === "skills/extraRoots/set") {
              assert.deepEqual(peer.methods.slice(0, 3), [
                "initialize",
                "initialized",
                "skills/extraRoots/set",
              ]);
              assert.deepEqual(params?.extraRoots, roots);
              if (failure === "exit") {
                yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1));
                yield* Queue.end(output);
              } else if (failure !== undefined) {
                yield* respond({ id, error: { code: failure, message: "root setup rejected" } });
              } else {
                peer.configured = true;
                yield* respond({ id, result: {} });
              }
            } else if (
              method === "thread/start" ||
              method === "thread/resume" ||
              method === "turn/start"
            ) {
              // The first usable turn requires this process's configured skill, so a missing hook cannot pass.
              if (failure === undefined && !peer.configured) {
                yield* respond({
                  id,
                  error: { code: -32000, message: "required skill unavailable" },
                });
              } else {
                yield* respond({
                  id,
                  result:
                    method === "turn/start"
                      ? wireFixture.responses.turnStart
                      : wireFixture.responses.threadStart,
                });
                if (nativeChild && method === "turn/start") {
                  const activity = wireFixture.notifications.find(
                    (event) => event.method === "item/completed",
                  );
                  if (activity) yield* respond(activity);
                }
              }
            } else if (method === "thread/goal/get") {
              yield* respond({ id, result: { goal: null } });
            } else if (method === "skills/list") {
              yield* respond({
                id,
                result: { data: [{ cwd, skills: peer.configured ? skills : [], errors: [] }] },
              });
            } else if (method === "account/read") {
              yield* respond({
                id,
                result: { account: { type: "apiKey" }, requiresOpenaiAuth: false },
              });
            } else if (method === "model/list") {
              yield* respond({ id, result: { data: [], nextCursor: null } });
            } else if (method === "account/rateLimits/read") {
              yield* respond({ id, error: { code: -32000, message: "unused rate limits" } });
            } else {
              yield* respond({ id, result: {} });
            }
          }
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(processes.length),
        stdin,
        stdout: Stream.encodeText(Stream.fromQueue(output)),
        stderr: Stream.empty,
        all: Stream.never,
        exitCode: Deferred.await(exited),
        isRunning: Effect.sync(() => !peer.closed),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return {
    processes,
    spawner,
    close: Effect.suspend(() => Effect.forEach(closers, (close) => close, { discard: true })),
  };
}

const runtimeInput = {
  threadId: ThreadId.make("extra-root-runtime"),
  binaryPath: "codex",
  cwd,
  runtimeMode: "full-access" as const,
  homePath: NodePath.join(cwd, "codex-identity"),
  environment: { AUTH_SENTINEL: "unchanged" },
  skillExtraRoots: roots,
};
const probeInput = {
  binaryPath: "codex",
  cwd,
  homePath: runtimeInput.homePath,
  skillExtraRoots: roots,
};

it.effect(
  "picker and status use independent process scopes and preserve skill order and duplicates",
  () =>
    Effect.gen(function* () {
      const peer = makePeer();
      const config = yield* decodeCodexSettings(probeInput);
      yield* Effect.gen(function* () {
        const discovered = yield* probeCodexSkillsForCwd(probeInput).pipe(Effect.scoped);
        assert.deepEqual(
          discovered.map(({ name, path }) => ({ name, path })),
          skills.map(({ name, path }) => ({ name, path })),
        );
        const status = yield* checkCodexProviderStatus(config);
        assert.deepEqual(
          status.skills.map(({ name, path }) => ({ name, path })),
          discovered.map(({ name, path }) => ({ name, path })),
        );
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner));
      assert.equal(peer.processes.length, 2);
      assert.isTrue(peer.processes.every((process) => process.configured && process.closed));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(`picker skips empty roots and does not invoke the setter`, () =>
  Effect.gen(function* () {
    const peer = makePeer(-32601);
    yield* Effect.gen(function* () {
      {
        assert.deepEqual(yield* probeCodexSkillsForCwd({ ...probeInput, skillExtraRoots: [] }), []);
      }
    }).pipe(
      Effect.ensuring(peer.close),
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner),
    );
    assert.notInclude(peer.processes[0]!.methods, "skills/extraRoots/set");
    assert.isTrue(peer.processes[0]?.closed);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(`picker continues on typed method-not-found without adopting roots`, () =>
  Effect.gen(function* () {
    const peer = makePeer(-32601);
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    yield* Effect.gen(function* () {
      {
        assert.deepEqual(yield* probeCodexSkillsForCwd(probeInput), []);
      }
    }).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.ensuring(peer.close),
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner),
    );
    assert.include(messages.flat().join(" "), "configured roots were not applied");
    assert.isFalse(peer.processes[0]?.configured);
    assert.isTrue(peer.processes[0]?.closed);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([-32602, -32000, -32600, "exit"] as const)(
  "picker propagates root failure %s and releases the process scope",
  (failure) =>
    Effect.gen(function* () {
      const peer = makePeer(failure);
      const result = yield* Effect.gen(function* () {
        {
          yield* probeCodexSkillsForCwd(probeInput);
        }
      }).pipe(
        Effect.ensuring(peer.close),
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(result));
      assert.isTrue(peer.processes[0]?.closed);
      assert.notInclude(peer.processes[0]!.methods, "skills/list");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(`picker rejects relative roots before spawning`, () =>
  Effect.gen(function* () {
    const peer = makePeer();
    const result = yield* Effect.gen(function* () {
      {
        yield* probeCodexSkillsForCwd({ ...probeInput, skillExtraRoots: ["relative/skills"] });
      }
    }).pipe(
      Effect.ensuring(peer.close),
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(result));
    assert.equal(peer.processes.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);
