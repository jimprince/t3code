# Plan: Remove Legacy localStorage Migration Paths and Resolve CR Feedback Cohesively

## Summary
Delete all runtime migration pathways that ingest legacy browser localStorage state into the new SQLite-backed model, then resolve the remaining code review (CR) findings in grouped workstreams.

This plan intentionally removes migration code instead of improving it. The target is a single canonical state flow: server-backed bootstrap + state events only, with no legacy data import bridge.

## Goals
1. Remove legacy localStorage migration for renderer state completely.
2. Remove dead contracts, RPC methods, server handlers, client callers, and tests tied to that migration.
3. Resolve valid CR findings on the retained architecture.
4. Close review threads with explicit outcomes: fixed, superseded by deletion, or declined with rationale.

## Non-Goals
1. Preserving one-time automatic import of old renderer localStorage data.
2. Refactoring unrelated UX persistence (theme/editor preferences) unless directly required by CR items.
3. Large behavior changes outside correctness/reliability fixes raised in CR.

## Architecture Decision
- Canonical state source remains SQLite + `state.bootstrap` + `state.catchUp` + streamed `stateEvent` updates.
- Legacy renderer-state migration is removed entirely.
- Existing server-side `projects.json` import path is kept unless explicitly removed in a follow-up (it is not localStorage-based).

## Workstream 1: Delete Legacy localStorage Migration End-to-End

### 1.1 Contracts and WS protocol cleanup
- Remove `stateImportLegacyRendererState` from `packages/contracts/src/ws.ts`.
- Remove state import input/result schemas and exported types from `packages/contracts/src/state.ts`.
- Remove IPC surface for `state.importLegacyRendererState` in `packages/contracts/src/ipc.ts`.
- Update and prune contracts tests in `packages/contracts/src/state.test.ts` and any IPC/WS tests that reference removed symbols.

### 1.2 Server cleanup
- Remove `PersistenceService.importLegacyRendererState(...)` and associated metadata key/constants used only for this import path.
- Remove WS routing case for `WS_METHODS.stateImportLegacyRendererState` in `apps/server/src/wsServer.ts`.
- Remove server tests that exercise legacy renderer import via RPC and service unit tests.
- Ensure no dead helpers remain (payload mapping, metadata flags, schema imports, etc.).

### 1.3 Web client cleanup
- Remove legacy key constants and helper functions from `apps/web/src/routes/__root.tsx`:
  - `CURRENT_RENDERER_STATE_KEY`
  - `LEGACY_RENDERER_STATE_KEYS`
  - `readLegacyRendererImportPayload`
  - `clearLegacyRendererState`
  - import-and-refresh bootstrap branch invoking `api.state.importLegacyRendererState(...)`
- Remove `hydratePersistedState` dependency from root route.
- Delete or narrow `apps/web/src/persistenceSchema.ts` to only what is still used. If unused after migration removal, delete file and tests.
- Remove `state.importLegacyRendererState` call path from `apps/web/src/wsNativeApi.ts`.

### 1.4 Dead-code verification pass
- `rg` for: `importLegacyRendererState`, `stateImportLegacyRendererState`, `renderer-state:v`, `hydratePersistedState`, legacy metadata keys.
- Ensure zero references remain in app code, contracts, and tests.

## Workstream 2: Resolve CR Findings in Surviving Code (Grouped by Relevance)

### Group A: Data integrity and transactional correctness (highest priority)
- `apps/server/src/persistenceService.ts`
  - Fix `listMessages` pagination progress: use fetched row count for `nextOffset`.
  - Guard `withTransaction` post-commit event emission so listener exceptions do not surface as transaction failures.
  - Preserve `checkpointTurnCount = 0` in turn-summary merge logic.
  - Prevent `item/started` from clobbering previously accumulated assistant text when events arrive out of order.
- `apps/server/src/wsServer.ts`
  - Wrap/contain `applyCheckpointRevert` persistence update so provider revert success is not falsely returned as failure.
- `apps/server/src/stateDb.ts`
  - Close DB when migration initialization fails in constructor.
  - Preserve original transaction error if rollback also throws.

### Group B: API/contract clarity and ownership boundaries
- `apps/server/src/wsServer.ts` + `packages/contracts/src/ipc.ts` + `apps/web/src/wsNativeApi.ts`
  - Remove ambiguous generic `threads.update` or make it explicit/unsupported (single canonical terminal-state update route).
  - Align method names/types with actual handlers.
- `apps/server/src/wsServer.ts`
  - Track ownership of injected `persistenceService`; only close internally owned instance in `stop()`.
- `apps/server/src/sqliteAdapter.ts`
  - Add explicit guard/error message when `node:sqlite` is unavailable.

### Group C: Client consistency and race prevention
- `apps/web/src/appSettings.ts`
  - Add hydration/update sequence guard so hydration cannot overwrite optimistic writes.
- `apps/web/src/store.ts`
  - Harden `thread.upsert` normalization to avoid crashes on missing terminal arrays (safe defaults before terminal normalization).
- `apps/web/src/components/Sidebar.tsx`
  - Fix no-API thread creation path (do not call API-gated `handleNewThread` in browser-only fallback).
- `apps/web/src/components/BranchToolbar.tsx` + `apps/web/src/components/ChatView.tsx`
  - Remove duplicate `updateBranch` network write path.

### Group D: Test reliability and cleanup
- `apps/server/src/persistenceService.test.ts`
  - Make timestamp helper deterministic.
  - Ensure service instances are always closed via `try/finally`.
  - Replace always-true catch-up sequence assertion with monotonic/defined sequence checks.
- Update/add tests for Group A/B/C behavior changes.

## Workstream 3: Review Thread Triage/Closure Strategy

### Threads closed by deletion (Workstream 1)
- Legacy renderer import flow/race concerns in root route.
- Legacy import schemas, WS method concerns, and related service import concerns.
- Any CR comments rooted in the removed migration path.

### Threads closed by fixes (Workstream 2)
- Transaction semantics, pagination correctness, branch update duplication, no-API thread creation, etc.

### Threads closed with rationale (no change)
- Keep concise “not adopted” notes only where behavior is intentional and safe.

## Execution Order
1. Contracts + protocol deletions (Workstream 1.1).
2. Server deletion and compilation fixes (Workstream 1.2).
3. Web deletion and compilation fixes (Workstream 1.3).
4. Dead-code sweep and test pruning (Workstream 1.4).
5. Group A fixes + tests.
6. Group B fixes + tests.
7. Group C fixes + tests.
8. Group D test hardening.
9. Final lint/test pass; prepare review-thread response mapping.

## Validation Matrix
- Lint: `bun run lint`.
- Contracts tests: `bun --cwd packages/contracts test` (or workspace equivalent).
- Server tests (required for backend changes): `bun --cwd apps/server test`.
- Web tests: `bun --cwd apps/web test`.
- Grep-based dead-code validation for removed migration symbols.

## Done Criteria
1. No runtime path exists to import legacy renderer localStorage into server state.
2. No dead symbols remain for removed migration APIs.
3. CR high/medium validity issues in retained code are fixed or explicitly dispositioned.
4. Backend tests and project lint pass.
5. PR discussion can be answered thread-by-thread with: fixed / superseded / intentionally declined.
