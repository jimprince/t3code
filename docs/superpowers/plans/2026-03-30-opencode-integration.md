# OpenCode Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild OpenCode as a first-class provider on top of the current upstream `t3code` contracts, server, orchestration, web, and docs so testers can configure it, run sessions, respond to approvals and user input, and finish with a green repo-wide verification gauntlet.

**Architecture:** Keep the current upstream provider/session/orchestration architecture as the source of truth. Port behavior from `stash@{1}` only where needed, translating it into the existing provider registry, runtime ingestion, and web state flows instead of reviving the older fork-only `ProviderHealth` design.

**Tech Stack:** Bun monorepo, Effect Schema, Vitest, React/Vite, Node server provider layers, `@opencode-ai/sdk` v2, SQLite-backed persistence.

---

Date: 2026-03-30 at 12:20 PDT
Session: ~/Desktop/WIP/t3-and-opencode/t3code
Project: ~/Desktop/WIP/t3-and-opencode/t3code

## Problem Statement

Current upstream `t3code` only supports `codex` and `claudeAgent`. OpenCode is partially teased in the UI but not wired through contracts, server provider layers, orchestration, settings, or docs. The previous OpenCode implementation survives only in `stash@{1}` and must be adapted, not replayed, because upstream architecture changed.

## Scope

In Scope:

- Normalize repo instruction files at the real repo root.
- Add `opencode` to shared contracts, model defaults, server settings, and runtime schemas.
- Port OpenCode server runtime pieces into the current provider registry and session architecture.
- Project OpenCode events through current orchestration, session, and activity flows.
- Expose OpenCode settings, selection, and pending user-input handling in the web app.
- Update tester-facing docs for setup and usage.
- Finish with `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

Out of Scope:

- Restoring the old fork architecture wholesale.
- Adding non-OpenCode provider features unrelated to parity.
- Refactoring unrelated upstream subsystems beyond what OpenCode integration requires.

Deferred:

- Long-tail parity with every stash-era internal abstraction not needed for a publishable branch.
- Post-integration cleanup refactors once the provider is fully working.

Why Not Replay `stash@{1}` Directly:

- The stash was built against older provider, discovery, and session layers and would reintroduce structures upstream no longer uses. Behavior should be ported into the current architecture instead.

## Context and Background

Source: ~/Desktop/WIP/t3-and-opencode/t3code/docs/superpowers/specs/2026-03-30-opencode-integration-design.md (Sections: "Architecture Strategy", "Subsystem Design", "Execution Order", "Verification Strategy")

- The actual repo root is `~/Desktop/WIP/t3-and-opencode/t3code`; planning initially started one directory too high, so all implementation paths must target this root.
- `~/Desktop/WIP/t3-and-opencode/t3code/AGENTS.md` currently contains the full project instructions and `CLAUDE.md` is missing. Phase 1 must normalize that before implementation continues.
- `~/Desktop/WIP/t3-and-opencode/t3code/packages/shared/src/DrainableWorker.ts` already has a pre-existing local modification and must not be overwritten as part of this work.
- The most useful behavioral references live in `stash@{1}` and its untracked third parent `stash@{1}^3`. Inspect them with `git show 'stash@{1}^3:<path>'` rather than trying to restore the stash wholesale.
- The current OpenCode SDK docs confirm the v2 TypeScript client import path is `@opencode-ai/sdk/v2`, and confirm `session.*`, `promptAsync`, `abort`, `fork`, `permission.reply`, and `event.subscribe` surfaces. Less-visible methods such as `question.reply` and provider config discovery should be verified against installed typings during Phase 2 before adapter wiring is finalized.

## Success Criteria

| Outcome                                              | Measurement                                                                                        | Target                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| OpenCode is a first-class provider                   | `ProviderKind`, settings, server snapshot, and web selection all accept `opencode`                 | Implemented and covered by tests                                    |
| OpenCode session flows work end-to-end               | Real session start, send, and respond flows exist across contracts, server, orchestration, and web | Implemented with targeted tests in each layer                       |
| Pending approvals and user-input flows stay coherent | OpenCode requests project into existing activities and pending state and can be resolved           | Implemented with targeted runtime and web tests                     |
| Publishable branch is verifiable                     | Repo-wide verification gauntlet completes cleanly                                                  | `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass |
| Tester onboarding is complete                        | Required setup and usage docs mention OpenCode accurately                                          | Listed docs updated in Phase 5                                      |

## Constraints and Assumptions

- Technical constraints:
  - Preserve the current upstream provider, session, and orchestration layering.
  - Do not use `bun test`; always use `bun run test`.
  - Keep `packages/contracts` schema-only and avoid moving runtime logic into it.
  - Treat `stash@{1}` as behavior reference, not file-shape authority.
- Compatibility constraints:
  - Existing `codex` and `claudeAgent` behavior must continue to decode persisted data and existing session payloads.
  - Any contract changes that rename fields must either be migrated through all active consumers in the same execution phase or staged so intermediate phases remain buildable.
- Performance constraints:
  - Preserve current queue-backed worker behavior in provider orchestration flows.
  - Reuse pooled OpenCode servers per `poolRoot + binaryPath` rather than spawning a new sidecar for every turn.
- Security/compliance constraints:
  - Do not commit secrets or machine-specific credentials.
  - Keep binary-path configuration explicit and user-controlled.
- Assumptions:
  - `stash@{1}^3` continues to hold the original OpenCode adapter, pool, and event mapping files.
  - `@opencode-ai/sdk` v2 remains the correct client surface for `opencode serve` integration.
  - The user wants execution to continue from the existing feature branch rather than from a new worktree.

## Phase Overview

| Phase | Focus                                                 | Key Deliverable                                                                        |
| ----- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1     | Instruction bootstrap and contracts/shared foundation | Normalized repo instructions plus green contract/shared OpenCode schema tests          |
| 2     | Server provider integration                           | OpenCode adapter, server pool, registry wiring, and provider snapshot support          |
| 3     | Orchestration and projection                          | OpenCode runtime events project into current thread, session, and activity state       |
| 4     | Web UX and pending input flows                        | OpenCode is selectable, configurable, and pending user-input UX matches the new schema |
| 5     | Documentation                                         | Updated architecture, quick-start, runtime docs, plus OpenCode prerequisites           |
| 6     | Final verification                                    | Full repo gauntlet and doc/instruction conformance                                     |

## External Library Verification

| Library            | Version/Range                                | Verified Source                                                                          | Notes                                                                                                                                             |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opencode-ai/sdk` | current v2 line to be added in `apps/server` | Context7 `/anomalyco/opencode` docs for `createOpencodeClient` and v2 session/event APIs | Use `@opencode-ai/sdk/v2` import path. Confirm `question.reply` and provider-discovery typings locally after install before final adapter wiring. |

## Phase 1: Instruction Bootstrap And Contracts/Shared Foundation

### Goal

Normalize repo instruction files and land the minimal `opencode` contract/shared model surface with red-then-green tests.

### Why This First

- Instruction-file normalization is required before implementation.
- All later server and web changes depend on shared provider, model, and runtime schemas.

### Implementation

- [ ] Step 1: Create `~/Desktop/WIP/t3-and-opencode/t3code/CLAUDE.md` with the current project instructions from the existing repo-root `AGENTS.md`, then reduce `~/Desktop/WIP/t3-and-opencode/t3code/AGENTS.md` to exactly `Read @CLAUDE.md`.
- [ ] Step 2: Run the existing red tests that define the first slice:
  - `bun --cwd packages/contracts run test -- src/provider.test.ts src/providerRuntime.test.ts`
  - `bun --cwd packages/shared run test -- src/model.test.ts`
- [ ] Step 3: Update shared schemas so `opencode` becomes a supported provider in current upstream shapes:
  - add `opencode` to `ProviderKind` and all provider-indexed records
  - add `OpenCodeModelSelection` to the `ModelSelection` union
  - add default model, alias, and display-name support for OpenCode
  - extend provider session start input with `poolRoot` and `providerOptions.opencode.binaryPath`
  - change user-input question decoding from legacy `multiSelect` to `multiple`, and add `custom`
- [ ] Step 4: Update shared runtime helpers so OpenCode model defaults and `resolveApiModelId` behavior pass through without Claude-specific rewriting.
- [ ] Step 5: Re-run the same tests until they pass, then run:
  - `bun --cwd packages/contracts run typecheck`
  - `bun --cwd packages/shared run typecheck`

### Files to Modify

| File (absolute path)                                                           | Type   | Priority |
| ------------------------------------------------------------------------------ | ------ | -------- |
| ~/Desktop/WIP/t3-and-opencode/t3code/CLAUDE.md                                 | create | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/AGENTS.md                                 | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/orchestration.ts   | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/model.ts           | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/provider.ts        | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/providerRuntime.ts | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/settings.ts        | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/server.ts          | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/index.ts           | modify | low      |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/shared/src/model.ts              | modify | high     |

### Documentation Impact

- `~/Desktop/WIP/t3-and-opencode/t3code/CLAUDE.md` — add the real repo instructions at the correct repo root.
- `~/Desktop/WIP/t3-and-opencode/t3code/AGENTS.md` — replace the current full content with the single-line include required by the instruction bootstrap contract.

### Testing Impact

- Behaviors to test:
  - `ProviderSessionStartInput` accepts OpenCode start and recovery fields.
  - `ProviderSendTurnInput` accepts OpenCode model selections.
  - `ProviderRuntimeEvent` decodes OpenCode-style `multiple` and `custom` user-input questions.
  - shared model helpers return OpenCode defaults and preserve OpenCode model IDs.
- Edge/error cases:
  - runtime mode remains required
  - custom-only question with empty `options` decodes
  - unknown OpenCode model slugs pass through unchanged
- Planned commands:
  - `bun --cwd packages/contracts run test -- src/provider.test.ts src/providerRuntime.test.ts`
  - `bun --cwd packages/shared run test -- src/model.test.ts`
  - `bun --cwd packages/contracts run typecheck`
  - `bun --cwd packages/shared run typecheck`

### Exit Criteria

| Check                              | Command/Condition                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Instruction files normalized       | `CLAUDE.md` exists and `AGENTS.md` contains exactly `Read @CLAUDE.md`                       |
| Contract tests green               | `bun --cwd packages/contracts run test -- src/provider.test.ts src/providerRuntime.test.ts` |
| Shared model tests green           | `bun --cwd packages/shared run test -- src/model.test.ts`                                   |
| Contract/shared packages typecheck | `bun --cwd packages/contracts run typecheck` and `bun --cwd packages/shared run typecheck`  |

## Phase 2: Server Provider Integration

### Goal

Port OpenCode server runtime pieces into the current provider and session architecture and expose OpenCode in provider snapshots.

### Why This First

- The orchestration and web layers cannot consume OpenCode until the server can start sessions, stream events, and advertise provider capabilities.
- This phase locks in the provider integration boundary before higher-level projection and UI work.

### Implementation

- [ ] Step 1: Add the OpenCode SDK dependency in `~/Desktop/WIP/t3-and-opencode/t3code/apps/server/package.json` and the lockfile, then inspect installed typings to confirm the v2 client import and any less-documented methods before wiring adapters.
- [ ] Step 2: Port the stash-era OpenCode runtime building blocks into current server locations:
  - `OpenCodeAdapter`
  - `OpenCodeServerPool`
  - `opencodeEventMapping`
  - matching service interfaces and tests
- [ ] Step 3: Register OpenCode in current provider lookup and lifecycle layers so it appears alongside Codex and Claude without reviving the old provider-discovery architecture.
- [ ] Step 4: Teach persisted session binding to decode `opencode` rows and carry runtime payload needed for server-pool reuse.
- [ ] Step 5: Ensure provider snapshots expose install, auth, and model state for OpenCode through the existing `ServerProvider` shape.
- [ ] Step 6: Run focused server tests and typecheck.

### Files to Modify

| File (absolute path)                                                                             | Type   | Priority |
| ------------------------------------------------------------------------------------------------ | ------ | -------- |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/package.json                                    | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/bun.lock                                                    | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/OpenCodeAdapter.ts          | create | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/OpenCodeAdapter.test.ts     | create | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/OpenCodeServerPool.ts       | create | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/OpenCodeServerPool.test.ts  | create | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Services/OpenCodeAdapter.ts        | create | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Services/OpenCodeServerPool.ts     | create | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/opencodeEventMapping.ts            | create | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts  | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/ProviderSessionDirectory.ts | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/ProviderRegistry.ts         | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/ProviderService.ts          | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/serverLayers.ts                             | modify | medium   |

### Documentation Impact

- None — server plumbing changes alone do not change published tester docs until the full OpenCode workflow is wired and documented in Phase 5.

### Testing Impact

- Behaviors to test:
  - pooled OpenCode server reuse by `poolRoot + binaryPath`
  - session start, resume, send, abort, and request-reply flows through the current provider adapter interface
  - provider registry and session directory include `opencode`
  - server provider snapshots expose OpenCode models, install state, and auth state
- Edge/error cases:
  - missing or invalid OpenCode binary path
  - unknown persisted provider names still fail cleanly
  - server-pool reuse does not collapse per-thread `cwd`
- Planned commands:
  - `bun --cwd apps/server run test -- src/provider/Layers/OpenCodeAdapter.test.ts src/provider/Layers/OpenCodeServerPool.test.ts src/provider/Layers/ProviderAdapterRegistry.test.ts src/provider/Layers/ProviderSessionDirectory.test.ts src/provider/Layers/ProviderService.test.ts`
  - `bun --cwd apps/server run typecheck`

### Exit Criteria

| Check                                   | Command/Condition                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode server files exist and compile | `bun --cwd apps/server run typecheck`                                                                                                                                                                                                                                               |
| Server provider tests green             | `bun --cwd apps/server run test -- src/provider/Layers/OpenCodeAdapter.test.ts src/provider/Layers/OpenCodeServerPool.test.ts src/provider/Layers/ProviderAdapterRegistry.test.ts src/provider/Layers/ProviderSessionDirectory.test.ts src/provider/Layers/ProviderService.test.ts` |
| Provider directory decodes OpenCode     | persisted `opencode` bindings resolve through `ProviderSessionDirectory` tests                                                                                                                                                                                                      |
| Provider snapshots include OpenCode     | OpenCode appears in provider registry and service test expectations                                                                                                                                                                                                                 |

## Phase 3: Orchestration And Projection

### Goal

Project OpenCode runtime activity into the current orchestration read model so sessions, proposed plans, approvals, and pending user-input state stay coherent.

### Why This First

- The web layer depends on stable orchestration events and read-model state, not raw provider events.
- This phase is where OpenCode behavior either becomes coherent or stays half-integrated.

### Implementation

- [ ] Step 1: Add or extend failing orchestration tests for OpenCode event ingestion and command handling before changing runtime projection code.
- [ ] Step 2: Update runtime ingestion to accept OpenCode event shapes from the new adapter mapping and produce the same canonical activity, session, and proposed-plan state the web already consumes.
- [ ] Step 3: Update the command reactor so OpenCode session start, send, and respond flows respect current runtime-mode and stale-request handling rules.
- [ ] Step 4: Keep the queue-backed worker, buffered assistant text, and proposed-plan buffering model intact while layering OpenCode event handling into it.
- [ ] Step 5: Re-run targeted orchestration tests and server typecheck.

### Files to Modify

| File (absolute path)                                                                                       | Type   | Priority |
| ---------------------------------------------------------------------------------------------------------- | ------ | -------- |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts      | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts        | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts   | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/opencodeEventMapping.ts                      | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/checkpointing/Utils.ts                                | modify | low      |

### Documentation Impact

- None — this phase changes internal event projection and persistence behavior, but the user-facing docs are updated together in Phase 5 once the integrated flow is stable.

### Testing Impact

- Behaviors to test:
  - OpenCode runtime events map into `thread.session.set`, activities, proposed plans, and pending user input
  - OpenCode command responses clear stale approval and user-input requests consistently
  - runtime mode and active-turn guards continue to behave correctly
- Edge/error cases:
  - orphaned request replies after restart
  - session exit clears buffered assistant and proposed-plan state
  - OpenCode runtime errors mark sessions correctly without corrupting unrelated turns
- Planned commands:
  - `bun --cwd apps/server run test -- src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
  - `bun --cwd apps/server run typecheck`

### Exit Criteria

| Check                                                 | Command/Condition                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration tests green                             | `bun --cwd apps/server run test -- src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` |
| Runtime projections remain typed                      | `bun --cwd apps/server run typecheck`                                                                                                                 |
| OpenCode activities and pending requests are coherent | Tests assert expected read-model activity, session, and pending state                                                                                 |

## Phase 4: Web UX And Pending Input Flows

### Goal

Make OpenCode selectable and configurable in the current UI, and update pending user-input handling for the OpenCode question schema.

### Why This First

- Once contracts and orchestration are stable, the web layer can adapt to the new provider without guessing at backend shapes.
- This phase converts the integration from backend-only to tester-usable.

### Implementation

- [ ] Step 1: Extend or add failing web tests for OpenCode provider availability, pending user-input resolution, and timeline or session derivation.
- [ ] Step 2: Remove the current OpenCode placeholder behavior and wire OpenCode through provider selection, model resolution, and settings state.
- [ ] Step 3: Update pending user-input helpers and UI to support `multiple` and `custom` question fields while preserving the current approval and timeline behavior.
- [ ] Step 4: Adapt any session-logic or composer registry code that still assumes only `codex` and `claudeAgent`.
- [ ] Step 5: Re-run targeted web tests and typecheck.

### Files to Modify

| File (absolute path)                                                                                | Type   | Priority |
| --------------------------------------------------------------------------------------------------- | ------ | -------- |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/providerModels.ts                                 | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/modelSelection.ts                                 | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/session-logic.ts                                  | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/session-logic.test.ts                             | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/pendingUserInput.ts                               | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/pendingUserInput.test.ts                          | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/hooks/useSettings.ts                              | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/store.ts                                          | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/types.ts                                          | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/components/settings/SettingsPanels.tsx            | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/components/chat/ProviderModelPicker.tsx           | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/components/chat/composerProviderRegistry.tsx      | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx | modify | high     |

### Documentation Impact

- None — the UI becomes usable in this phase, but the published usage and setup docs are updated together in Phase 5.

### Testing Impact

- Behaviors to test:
  - OpenCode shows up as a selectable provider instead of a placeholder
  - provider models and defaults resolve correctly for OpenCode
  - pending user-input drafts build the correct answer map for custom and multi-option questions
  - session logic derives pending OpenCode requests from projected activities
- Edge/error cases:
  - custom-only questions with no preset options
  - stale provider user-input failure clears pending prompts
  - provider fallback logic still behaves sensibly when OpenCode is disabled
- Planned commands:
  - `bun --cwd apps/web run test -- src/pendingUserInput.test.ts src/session-logic.test.ts`
  - `bun --cwd apps/web run typecheck`

### Exit Criteria

| Check                                      | Command/Condition                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Web tests green                            | `bun --cwd apps/web run test -- src/pendingUserInput.test.ts src/session-logic.test.ts`       |
| Web package typechecks                     | `bun --cwd apps/web run typecheck`                                                            |
| OpenCode is selectable and configurable    | UI code no longer treats OpenCode as "coming soon" and settings flows include OpenCode fields |
| Pending user-input logic matches contracts | Web helpers and tests use `multiple` and `custom` question fields                             |

## Phase 5: Documentation

### Goal

Update the repo docs needed for outside testers to install, configure, and use OpenCode on this branch.

### Why This First

- The branch is not publishable if external testers cannot set it up.
- Docs should only be finalized once the real integrated workflow is settled.

### Implementation

- [ ] Step 1: Compare current docs with stash-era OpenCode docs and port only the parts that remain accurate under the current upstream architecture.
- [ ] Step 2: Update architecture and quick-start docs to mention OpenCode as a supported provider in the current provider and session architecture.
- [ ] Step 3: Add `~/Desktop/WIP/t3-and-opencode/t3code/.docs/opencode-prerequisites.md` with concrete setup steps for installing and configuring the OpenCode binary and any provider-side prerequisites.
- [ ] Step 4: Cross-check the docs against the implemented settings, UI, and workflow so the branch’s actual behavior matches the written instructions.

### Files to Modify

| File (absolute path)                                                 | Type   | Priority |
| -------------------------------------------------------------------- | ------ | -------- |
| ~/Desktop/WIP/t3-and-opencode/t3code/.docs/architecture.md           | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/.docs/provider-architecture.md  | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/.docs/quick-start.md            | modify | high     |
| ~/Desktop/WIP/t3-and-opencode/t3code/.docs/runtime-modes.md          | modify | medium   |
| ~/Desktop/WIP/t3-and-opencode/t3code/.docs/opencode-prerequisites.md | create | high     |

### Documentation Impact

- `~/Desktop/WIP/t3-and-opencode/t3code/.docs/architecture.md` — describe OpenCode in the current upstream system architecture.
- `~/Desktop/WIP/t3-and-opencode/t3code/.docs/provider-architecture.md` — document OpenCode provider layering, session management, and event mapping at a high level.
- `~/Desktop/WIP/t3-and-opencode/t3code/.docs/quick-start.md` — add tester-facing setup and first-run guidance for OpenCode.
- `~/Desktop/WIP/t3-and-opencode/t3code/.docs/runtime-modes.md` — explain OpenCode runtime-mode behavior where it differs materially from other providers.
- `~/Desktop/WIP/t3-and-opencode/t3code/.docs/opencode-prerequisites.md` — provide dedicated OpenCode install and prerequisite guidance.

### Testing Impact

- Behaviors to test:
  - none via automated runtime tests; this phase is a doc accuracy pass
- Edge/error cases:
  - docs must not describe the old fork architecture or stale provider discovery paths
  - docs must mention the current OpenCode binary-path requirement and how testers surface the provider in the UI
- Planned commands:
  - manual cross-check against implemented settings, UI, and server behavior
  - optional `bun fmt` before final verification if docs formatting changes require it

### Exit Criteria

| Check                                   | Command/Condition                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Required docs updated                   | All five listed `*.md` files are present and mention current OpenCode behavior accurately                    |
| No stale architecture references remain | Docs reference current upstream provider and orchestration architecture rather than old fork-only structures |
| Tester setup path is explicit           | OpenCode prerequisites, binary path, and usage flow are documented end-to-end                                |

## Phase 6: Final Verification

### Goal

Prove the branch is publishable and that all docs and instruction files are synchronized with the shipped behavior.

### Why This First

- This is the hard completion gate from the spec and repo instructions.
- Cross-stack work is not complete until the repo-wide gauntlet is clean.

### Implementation

- [ ] Step 1: Run the full repo verification gauntlet from `~/Desktop/WIP/t3-and-opencode/t3code`:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - `bun run test`
- [ ] Step 2: Fix any failures using the smallest targeted changes that keep the earlier phases intact.
- [ ] Step 3: Confirm every `*.md` file listed in Documentation Impact sections was updated.
- [ ] Step 4: Confirm repo-root instruction-file conformance again.
- [ ] Step 5: Confirm the pre-existing local change in `~/Desktop/WIP/t3-and-opencode/t3code/packages/shared/src/DrainableWorker.ts` was not overwritten or reverted accidentally.

### Files to Modify

| File (absolute path)                 | Type   | Priority |
| ------------------------------------ | ------ | -------- |
| ~/Desktop/WIP/t3-and-opencode/t3code | verify | high     |

### Documentation Impact

- None — this phase is verification-only; it should only expose missing doc updates from earlier phases rather than introduce new documentation scope.

### Testing Impact

- Behaviors to test:
  - whole-repo formatting, linting, typing, and test health
  - final OpenCode integration regression surface across packages
- Edge/error cases:
  - stale instruction files
  - missing doc updates from earlier phases
  - repo-wide breakage from renamed shared schema fields
- Planned commands:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - `bun run test`

### Exit Criteria

| Check                       | Command/Condition                                                     |
| --------------------------- | --------------------------------------------------------------------- |
| Format passes               | `bun fmt`                                                             |
| Lint passes                 | `bun lint`                                                            |
| Typecheck passes            | `bun typecheck`                                                       |
| Tests pass                  | `bun run test`                                                        |
| Documentation sync complete | All files listed in Documentation Impact sections are updated         |
| Instruction files conform   | `CLAUDE.md` exists and `AGENTS.md` contains exactly `Read @CLAUDE.md` |

## Reference

### Critical Files Summary

| File                                                                                                  | Phases | Change Type            |
| ----------------------------------------------------------------------------------------------------- | ------ | ---------------------- |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/orchestration.ts                          | 1      | feature/schema         |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/contracts/src/providerRuntime.ts                        | 1      | feature/schema         |
| ~/Desktop/WIP/t3-and-opencode/t3code/packages/shared/src/model.ts                                     | 1      | feature/runtime helper |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/OpenCodeAdapter.ts               | 2      | feature                |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/Layers/OpenCodeServerPool.ts            | 2      | feature                |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/provider/opencodeEventMapping.ts                 | 2,3    | feature                |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts | 3      | feature                |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/pendingUserInput.ts                                 | 4      | feature                |
| ~/Desktop/WIP/t3-and-opencode/t3code/apps/web/src/components/settings/SettingsPanels.tsx              | 4      | feature/UI             |
| ~/Desktop/WIP/t3-and-opencode/t3code/.docs/opencode-prerequisites.md                                  | 5      | docs                   |

### Implementation Dependencies

Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5 -> Phase 6
