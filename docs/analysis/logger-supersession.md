# Provider logger supersession analysis

## Scope and comparison points

This analysis compares:

- fork tip `bfb5c36e3`
- upstream `v0.0.32-nightly.20260729.951` (which contains `49c0d96ed`)
- merge base `b64ae880e`

The proposed tree under `proposed/` is an overlay on the upstream tag. It preserves unrelated fork provider-runtime work while resolving the logging capabilities independently.

Unless a citation is prefixed with a commit, its file and line numbers refer to `v0.0.32-nightly.20260729.951`.

## Verdicts

| Capability                                                                         | Verdict                            | Resolution                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1. Separate log file per thread                                                    | **RETIRE**                         | Take upstream's shared store and its `events.<thread>.log` layout.                                                         |
| 2. `releaseThread` lifecycle                                                       | **KEEP**                           | Add thread release to the upstream store and retain the fork's `ProviderService` terminal/stop call sites.                 |
| 3. Global 2 GiB / 30-day retention                                                 | **NARROW**                         | Keep upstream's provider-only 512 MiB / 14-day policy and retain the fork's broader 2 GiB / 30-day `logsDir` sweep.        |
| 4. Successful trace-span rate limiting                                             | **KEEP**                           | Reapply the fork's per-name admission window around upstream's new chunked/attributed trace sink.                          |
| 5. Close/flush writers on shutdown                                                 | **RETIRE**                         | Take upstream's store finalizer and close implementation.                                                                  |
| 6a. Separate native/canonical files                                                | **RETIRE**                         | Upstream deliberately shares one sink per thread and labels each record; this removes the cross-writer rotation race.      |
| 6b. Safe thread names, `_global` fallback, rotation, and best-effort serialization | **RETIRE**                         | Upstream retains all of these and adds validation, bounded buffering, transient-event filtering, and resource attribution. |
| 6c. Spotlight exclusion marker for the whole logs tree                             | **KEEP** (as part of capability 3) | It exists only in the fork's global retention layer.                                                                       |

### 1. Per-thread writer splitting — RETIRE

Upstream explicitly defines the store as “one shared writer per thread” (`apps/server/src/provider/Layers/EventNdjsonLogger.ts:3-6`). Records are grouped by `threadSegment` and written through one sink selected by that segment (`EventNdjsonLogger.ts:359-368`); the resulting path is `${prefix}${threadSegment}.log` (`EventNdjsonLogger.ts:170-178`).

This implementation is exercised in production, not just exposed:

- `ProviderEventLoggers.make` constructs the shared store and obtains native/canonical views (`apps/server/src/provider/Layers/ProviderEventLoggers.ts:65-70,83-87`).
- The server installs that layer in the runtime (`apps/server/src/server.ts:357-362`).
- `ServerConfig` places it at `logs/provider/events.log`, producing `logs/provider/events.<thread>.log` (`apps/server/src/config.ts:112-126`).

The fork's stream-specific filenames (`<thread>.<stream>.log`) are at fork `EventNdjsonLogger.ts:215-219`. Upstream supersedes the underlying safety goal by sharing batching, rotation, and retention state between stream views, so two independent rotating sinks no longer race.

### 2. `releaseThread` lifecycle — KEEP

Upstream does not provide this lifecycle. Its public logger/store interfaces contain only `write`, `logger`, and `close` (`apps/server/src/provider/Layers/EventNdjsonLogger.ts:51-61`), and a full upstream grep of `apps/server/src` has no `releaseThread` call. Thread sinks are cached in `StoreState.sinks` (`EventNdjsonLogger.ts:128-135`) and otherwise survive until store shutdown.

The fork implements `releaseThread` by closing and deleting the thread writer (`bfb5c36e3:apps/server/src/provider/Layers/EventNdjsonLogger.ts:285-304`) and exercises it at all traced thread-end paths:

- provider terminal event: `bfb5c36e3:apps/server/src/provider/Layers/ProviderService.ts:360-372`
- explicit `stopSession`: `ProviderService.ts:1166-1174`
- `stopAll`/service shutdown: `ProviderService.ts:1360-1368`

The proposal adapts that contract to upstream's sink model. `RotatingFileSink` holds no file descriptor—it appends synchronously per write (`packages/shared/src/logging.ts:44-50,85-95`)—so “release” now means: flush accepted records, evict the thread's cached sink, and allow a later write to reopen it. The optional logger method keeps existing test doubles source-compatible.

### 3. Global retention — NARROW

The policies differ in both scope and limits:

- Fork: **2 GiB / 30 days**, recursively across the entire `logsDir`, swept hourly (`bfb5c36e3:apps/server/src/observability/LogRetention.ts:13-15,62-85,114-146`). It is wired into the runtime at fork `apps/server/src/server.ts:364-370`.
- Upstream: **512 MiB / 14 days** by default (`apps/server/src/provider/Layers/EventNdjsonLogger.ts:25-32,309-319`), limited to files recognized as provider event logs (`EventNdjsonLogger.ts:223-235`). It runs at store startup (`EventNdjsonLogger.ts:463-479`) and on due flushes (`EventNdjsonLogger.ts:404-419`), through the production store/layer call sites above.

Upstream therefore partially covers retention but does not cap `server.log`, `server.trace.ndjson`, terminal logs, or other nested log producers. The recommendation is to keep both layers: upstream's tighter provider-event sub-cap and the fork's broader last-resort cap. These are maximums, so the 14-day provider policy does not conflict with the 30-day global ceiling.

The fork's `.metadata_never_index` creation (`LogRetention.ts:16,87-90`) also remains useful and is not present upstream.

### 4. Rate-limiting successful trace spans — KEEP

The fork admits at most 200 fast successful spans per record-name/type per 60-second window, while always retaining failures and spans at least 250 ms (`bfb5c36e3:packages/shared/src/observability.ts:11-14,279-310,320-387`). The server exercises the default behavior by constructing this sink in `bfb5c36e3:apps/server/src/observability/Layers/Observability.ts:28-35`.

Upstream's `makeTraceSink` has no admission state or successful-span options: every record is appended to the buffer (`packages/shared/src/observability.ts:281-294,359-366`). The live server still constructs that sink (`apps/server/src/observability/Layers/Observability.ts:30-45`), so upstream's new write attribution does not supersede rate limiting. Upstream does use untraced functions in the provider-event store, which reduces one source of spans, but that is not a global bound on successful spans from RPC, persistence, VCS, or other components.

The proposal combines both: upstream's oversized-record handling, bounded chunks, `throwOnError`, and `onFlush` attribution remain; the fork's admission check runs before a record enters that buffer. Suppression counts are attached to the next retained failure/slow/success record.

### 5. Writer close/flush on shutdown — RETIRE

Upstream's store `close` drains pending records and closes its timer scope (`apps/server/src/provider/Layers/EventNdjsonLogger.ts:547-550`). The production `ProviderEventLoggers` layer registers `store.close()` as a finalizer (`apps/server/src/provider/Layers/ProviderEventLoggers.ts:83`) and that layer is installed by the server (`apps/server/src/server.ts:357-362`).

This is stronger than the fork's shutdown coverage for shared loggers: it flushes all remaining thread and `_global` records once, at the actual store owner. Keep the fork's per-thread release for steady-state resource reclamation, but retire its architecture as the shutdown mechanism.

## Additional upstream behavior to adopt

The upstream store should otherwise remain intact:

- transient canonical deltas are filtered before serialization (`EventNdjsonLogger.ts:39-47,180-189,557-560`);
- pending memory is bounded by 1 MiB or 512 records (`EventNdjsonLogger.ts:33-34,569-577`);
- configuration is validated (`EventNdjsonLogger.ts:295-337`);
- logical writes are attributed by stream (`EventNdjsonLogger.ts:514-535`);
- native, canonical, and orchestration records retain explicit labels (`EventNdjsonLogger.ts:166-168,562-564`).

## Resolution strategy for the five conflicts

| Conflicted file                                             | Proposed resolution                                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/Layers/EventNdjsonLogger.ts`      | Use upstream wholesale, then add the adapted `releaseThread` store/view API. Do not restore fork `Logger.batched`, separate stream files, 200 ms window, or independent writer maps.                          |
| `apps/server/src/provider/Layers/EventNdjsonLogger.test.ts` | Use upstream's expanded store/filter/buffer/retention/attribution tests and add one release/reopen regression test.                                                                                           |
| `apps/server/src/provider/Layers/ProviderRegistry.test.ts`  | Semantic union: preserve fork `Deferred` tests and deterministic failing spawner, and add upstream's always-run `BackgroundPolicy` mock at every new dependency site. This conflict is incidental to logging. |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`      | Preserve the fork's runtime fixture/environment additions but take upstream's `provider-native.<thread>.log` expectation.                                                                                     |
| `apps/server/src/provider/Drivers/OpenCodeDriver.ts`        | Keep the fork's 10-minute probe server pool, while taking upstream's `BackgroundPolicy` dependency and removal of unconditional five-minute snapshot refresh. This conflict is incidental to logging.         |

## Additional proposed files

The following are included because a five-file-only answer would not be internally consistent:

- `apps/server/src/provider/Layers/ProviderService.ts` and `.test.ts`: retain the three thread-release consumer paths.
- `apps/server/src/server.ts`: combine upstream background/resource diagnostics with fork thread-transfer wiring and `LogRetentionLive`.
- `apps/server/src/observability/LogRetention.ts` and `.test.ts`: preserve global retention.
- `packages/shared/src/observability.ts` and `.test.ts`: combine rate limiting with upstream trace write chunking/attribution.
- `apps/server/src/provider/OpenCodeServerPool.ts` and `.test.ts`: satisfy the retained OpenCode driver dependency.

`apps/server/src/provider/Layers/ProviderEventLoggers.ts` is intentionally not mirrored because the correct resolution is the upstream file unchanged; it already owns the shared store and shutdown finalizer.

## Sanity and traced API limits

- All logger construction and release consumers under `apps/server/src` were traced at both tips.
- `RotatingFileSink` was traced and has no open-handle `close` API; the proposed release semantics are therefore flush + cache eviction, not descriptor closure.
- No unresolved API was found in the traced source. The proposal is an analysis overlay rather than a buildable alternate source root; validation must copy it over the upstream tree before a definitive typecheck.

## Verification performed

- `vp fmt --check` passed for all 14 proposed files after overlaying them on a clean checkout of the upstream tag.
- Focused tests passed after the same overlay: 32 tests across `EventNdjsonLogger.test.ts`, `LogRetention.test.ts`, and `packages/shared/src/observability.test.ts`; and 5 tests in `OpenCodeServerPool.test.ts`.
- The new release test was mutation-checked: replacing `releaseThread` with a no-op made the test fail because the released thread log survived retention; restoring eviction made it pass.
- A combined `@t3tools/shared` / server typecheck was attempted in a clean upstream-tag overlay, but the available `node_modules` was symlinked from the newer fork checkout. It failed in unrelated upstream settings modules because those installed contracts did not export the tag's new settings APIs. No diagnostic named a proposed logger, retention, or observability file, but this dependency skew means a full typecheck remains unverified.
