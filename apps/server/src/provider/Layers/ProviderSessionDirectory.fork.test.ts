// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import { assertSome } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeServerBootGenerationLayer } from "./ServerBootGeneration.ts";

function makeDirectoryLayer<E, R>(
  persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
  bootGenerationId = "boot-a",
) {
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(Layer.provide(persistenceLayer));
  const bootGenerationLayer = makeServerBootGenerationLayer(bootGenerationId);
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(
      Layer.provide(Layer.merge(runtimeRepositoryLayer, bootGenerationLayer)),
    ),
    bootGenerationLayer,
    NodeServices.layer,
  );
}

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ProviderSessionDirectoryLive", (it) => {
  it("upserts and reads thread bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initialThreadId = ThreadId.make("thread-1");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId: initialThreadId,
      });

      const provider = yield* directory.getProvider(initialThreadId);
      assert.equal(provider, "codex");
      const resolvedBinding = yield* directory.getBinding(initialThreadId);
      assertSome(resolvedBinding, {
        threadId: initialThreadId,
        provider: ProviderDriverKind.make("codex"),
      });
      if (Option.isSome(resolvedBinding)) {
        assert.equal(resolvedBinding.value.threadId, initialThreadId);
      }

      const nextThreadId = ThreadId.make("thread-2");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId: nextThreadId,
      });
      const updatedBinding = yield* directory.getBinding(nextThreadId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.threadId, nextThreadId);
      }

      const runtime = yield* runtimeRepository.getByThreadId({ threadId: nextThreadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, nextThreadId);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.providerName, "codex");
        assert.equal(runtime.value.bootGenerationId, "boot-a");
      }

      const threadIds = yield* directory.listThreadIds();
      assert.deepEqual(threadIds, [nextThreadId]);
    }));

  it("persists runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = ThreadId.make("thread-runtime");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        status: "starting",
        resumeCursor: {
          threadId: "provider-thread-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, threadId);
        assert.equal(runtime.value.status, "running");
        assert.deepEqual(runtime.value.resumeCursor, {
          threadId: "provider-thread-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          activeTurnId: "turn-1",
        });
        assert.equal(runtime.value.activeTurnId, "turn-1");
      }
    }));

  it("clears only the matching active turn and preserves a newer turn", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("thread-terminal-cas");
      const firstTurnId = TurnId.make("turn-1");
      const secondTurnId = TurnId.make("turn-2");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        activeTurnId: firstTurnId,
      });
      yield* directory.markTurnStarted({ threadId, turnId: secondTurnId });

      const staleCompletionApplied = yield* directory.markTurnTerminal({
        threadId,
        expectedTurnId: firstTurnId,
      });
      assert.equal(
        staleCompletionApplied,
        false,
        "REGRESSION: a late completion must not clear a newer active turn",
      );

      const currentCompletionApplied = yield* directory.markTurnTerminal({
        threadId,
        expectedTurnId: secondTurnId,
      });
      assert.equal(currentCompletionApplied, true);

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(binding), true);
      if (Option.isSome(binding)) {
        assert.equal(binding.value.activeTurnId, null);
        assert.deepEqual(binding.value.runtimePayload, { activeTurnId: null });
      }
    }));

  it("reserves a turn only while the session is idle", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("thread-turn-reservation-cas");
      const firstTurnId = TurnId.make("pending:first");
      const secondTurnId = TurnId.make("pending:second");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        activeTurnId: null,
      });
      assert.equal(
        yield* directory.markTurnStarted({
          threadId,
          turnId: firstTurnId,
          expectedActiveTurnId: null,
        }),
        true,
      );
      assert.equal(
        yield* directory.markTurnStarted({
          threadId,
          turnId: secondTurnId,
          expectedActiveTurnId: null,
        }),
        false,
        "REGRESSION: a concurrent send replaced an existing turn reservation",
      );

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.getOrUndefined(binding)?.activeTurnId, firstTurnId);
    }));

  it("claims only an unchanged idle session and blocks a concurrent turn start", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("thread-idle-recovery-claim");
      const turnId = TurnId.make("turn-after-preview");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        activeTurnId: null,
      });
      const previewValue = (yield* directory.listBindings()).find(
        (binding) => binding.threadId === threadId,
      );
      const previewBinding = previewValue === undefined ? Option.none() : Option.some(previewValue);
      assert.equal(Option.isSome(previewBinding), true);
      if (Option.isNone(previewBinding)) return;

      assert.equal(yield* directory.markTurnStarted({ threadId, turnId }), true);
      assert.equal(
        yield* directory.claimIdleForRecovery({
          threadId,
          expectedLastSeenAt: previewBinding.value.lastSeenAt,
        }),
        false,
        "REGRESSION: recovery claimed a session after a turn started",
      );

      assert.equal(yield* directory.markTurnTerminal({ threadId, expectedTurnId: turnId }), true);
      const refreshedValue = (yield* directory.listBindings()).find(
        (binding) => binding.threadId === threadId,
      );
      const refreshedBinding =
        refreshedValue === undefined ? Option.none() : Option.some(refreshedValue);
      assert.equal(Option.isSome(refreshedBinding), true);
      if (Option.isNone(refreshedBinding)) return;

      assert.equal(
        yield* directory.claimIdleForRecovery({
          threadId,
          expectedLastSeenAt: refreshedBinding.value.lastSeenAt,
        }),
        true,
      );
      assert.equal(
        yield* directory.markTurnStarted({ threadId, turnId }),
        false,
        "REGRESSION: a turn started after recovery atomically claimed the session",
      );
    }));

  it("lists persisted bindings with metadata in oldest-first order", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const olderThreadId = ThreadId.make("thread-runtime-older");
      const newerThreadId = ThreadId.make("thread-runtime-newer");

      yield* runtimeRepository.upsert({
        threadId: newerThreadId,
        providerName: "codex",
        providerInstanceId: null,
        bootGenerationId: "boot-newer",
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        activeTurnId: null,
        lastSeenAt: "2026-04-14T12:05:00.000Z",
        resumeCursor: {
          opaque: "resume-newer",
        },
        runtimePayload: {
          cwd: "/tmp/newer",
        },
      });

      yield* runtimeRepository.upsert({
        threadId: olderThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        bootGenerationId: "boot-older",
        adapterKey: "claudeAgent",
        runtimeMode: "approval-required",
        status: "starting",
        activeTurnId: null,
        lastSeenAt: "2026-04-14T12:00:00.000Z",
        resumeCursor: {
          opaque: "resume-older",
        },
        runtimePayload: {
          cwd: "/tmp/older",
        },
      });

      const bindings = yield* directory.listBindings();

      assert.deepEqual(bindings, [
        {
          threadId: olderThreadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          bootGenerationId: "boot-older",
          adapterKey: "claudeAgent",
          runtimeMode: "approval-required",
          status: "starting",
          activeTurnId: null,
          lastSeenAt: "2026-04-14T12:00:00.000Z",
          resumeCursor: {
            opaque: "resume-older",
          },
          runtimePayload: {
            cwd: "/tmp/older",
          },
        },
        {
          threadId: newerThreadId,
          provider: ProviderDriverKind.make("codex"),
          bootGenerationId: "boot-newer",
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          activeTurnId: null,
          lastSeenAt: "2026-04-14T12:05:00.000Z",
          resumeCursor: {
            opaque: "resume-newer",
          },
          runtimePayload: {
            cwd: "/tmp/newer",
          },
        },
      ]);
    }));

  it("resets adapterKey to the new provider when provider changes without an explicit adapter key", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-provider-change");

      yield* runtimeRepository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        bootGenerationId: "legacy-boot",
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        activeTurnId: null,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        resumeCursor: null,
        runtimePayload: null,
      });

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerName, "codex");
        assert.equal(runtime.value.adapterKey, "codex");
      }
    }));

  it("stamps writes with the current boot generation and persists that generation across restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-boot-"));
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const threadId = ThreadId.make("thread-boot-generation");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          threadId,
        });

        const bindings = yield* directory.listBindings();
        assert.equal(bindings.length, 1);
        assert.equal(bindings[0]?.bootGenerationId, "boot-a");
      }).pipe(Effect.provide(makeDirectoryLayer(makeSqlitePersistenceLive(dbPath), "boot-a")));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const binding = yield* directory.getBinding(threadId);
        assert.equal(Option.isSome(binding), true);
        if (Option.isSome(binding)) {
          assert.equal(
            binding.value.bootGenerationId,
            "boot-a",
            "REGRESSION: persisted boot generation was recomputed from the current server boot",
          );
        }
      }).pipe(Effect.provide(makeDirectoryLayer(makeSqlitePersistenceLive(dbPath), "boot-b")));

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }));

  it("does not settle a binding that recovery already restamped to the current generation", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-generation-cas-race");
      const resumeCursor = { opaque: "resume-after-race" };
      const runtimePayload = { cwd: "/tmp/cas-race" };

      yield* runtimeRepository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: null,
        bootGenerationId: "previous-boot",
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        activeTurnId: null,
        lastSeenAt: "2026-07-19T00:00:00.000Z",
        resumeCursor,
        runtimePayload,
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        status: "running",
      });

      const settled = yield* directory.settleDeadGenerationBinding({
        threadId,
        expectedBootGenerationId: "previous-boot",
      });
      assert.equal(
        settled,
        false,
        "REGRESSION: stale reaper snapshot settled a concurrently recovered live binding",
      );

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.bootGenerationId, "boot-a");
        assert.deepEqual(runtime.value.resumeCursor, resumeCursor);
        assert.deepEqual(runtime.value.runtimePayload, runtimePayload);
      }
    }));

  it("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-directory-"));
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const threadId = ThreadId.make("thread-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          threadId,
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(threadId);
        assert.equal(provider, "codex");

        const resolvedBinding = yield* directory.getBinding(threadId);
        assertSome(resolvedBinding, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
        });
        if (Option.isSome(resolvedBinding)) {
          assert.equal(resolvedBinding.value.threadId, threadId);
        }

        const legacyTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'provider_sessions'
        `;
        assert.equal(legacyTableRows.length, 0);
      }).pipe(Effect.provide(directoryLayer));

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }));
});
