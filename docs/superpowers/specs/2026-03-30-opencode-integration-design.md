# OpenCode Integration Design

## Summary

Recreate the user's OpenCode integration on top of the latest upstream `pingdotgg/t3code` instead of restoring the older fork architecture. The current upstream branch is now the stable base, and the previous OpenCode work preserved in `stash@{1}` is the reference implementation. The goal is a publishable branch that lets outside testers configure OpenCode, select it as a provider, run sessions, stream turns, handle approvals and user input, and exercise the related UI and docs without breaking the current upstream verification baseline.

## Goals

- Keep latest upstream `t3code` as the base branch.
- Reintroduce OpenCode as a first-class provider in the current provider/orchestration/settings architecture.
- Preserve the user-visible OpenCode behaviors from the original integration as closely as possible.
- End with a branch that passes `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- Update the repository docs needed for outside testers to install and use the branch.

## Non-Goals

- Revert the repository back to the pre-upstream-merge fork state.
- Restore the older fork architecture wholesale if upstream has since replaced it.
- Guarantee full long-term parity with every old fork-specific internal abstraction when the same behavior can be expressed through newer upstream layers.
- Minimize changes at the expense of shipping a half-working provider. The branch should be meaningfully testable by other people.

## Source Material

- Base branch: current `origin/main`, already verified green after one upstream regression fix in `packages/shared/src/DrainableWorker.ts`.
- Primary reference: `stash@{1}` (`opencode-temp-upstream-sync-20260330`), which contains the original full OpenCode work plus related docs and tests.
- Secondary reference: `stash@{0}` (`opencode-temp-clean-upstream-baseline-20260330`), which contains a smaller post-merge subset and may help when the original stash conflicts with the newer upstream code shape.
- Git history: there is no clean OpenCode commit stack available to replay, so the stash content is the practical source of truth.

## Design Principles

1. Upstream architecture wins when old fork internals conflict with current structure.
2. OpenCode behavior is preserved by adaptation, not by forcing old file shapes back into the tree.
3. Integration should be rebuilt in vertical slices that keep the repository testable after each major subsystem lands.
4. Publishable behavior matters more than preserving every historical implementation detail.

## Target Behavior

After this integration, a tester should be able to:

- install the branch and its dependencies;
- see OpenCode represented as a supported provider in the app;
- configure the OpenCode settings exposed by the integration, including binary path and provider-specific options required to start sessions;
- create or resume an OpenCode-backed session;
- send turns and receive streamed assistant output;
- receive and respond to approvals and user-input questions from OpenCode;
- observe the expected projected session/thread state in the web app;
- use any updated UI affordances or docs needed to exercise the integration.

## Architecture Strategy

The integration will be rebuilt on top of the upstream architecture visible today:

- shared provider and runtime schemas live in `packages/contracts`;
- shared runtime helpers live in `packages/shared`;
- provider session management and adapter registration live under `apps/server/src/provider`;
- provider runtime events flow through the orchestration ingestion/projector layers in `apps/server/src/orchestration`;
- browser behavior flows through `apps/web` state, transport, settings, and chat components.

OpenCode will be added as another provider within these layers rather than by restoring the older `ProviderHealth` and `appSettings`-centered fork design as the dominant structure.

## Subsystem Design

### 1. Contracts And Shared Model Surface

`packages/contracts` and `packages/shared` will be updated so OpenCode exists as a supported provider in the same places where upstream currently models providers, model defaults, runtime events, and configuration exchange.

Expected changes:

- add `opencode` to provider discriminants and provider-indexed records;
- reintroduce any OpenCode model/default naming support needed by the current model picker and provider settings flows;
- widen provider runtime event and user-input schemas so OpenCode raw events and question payloads are representable;
- restore any server-config contract surface that the web app needs to discover provider capabilities or configuration state.

The schema work should prefer extending current upstream structures over reintroducing parallel legacy shapes. If the old stash used fields that upstream replaced, the OpenCode implementation will be moved to the newer field model.

### 2. Server Provider Integration

The server will regain the OpenCode runtime components from the stash, adapted to the current provider registry and session management layers.

Expected changes:

- restore any required OpenCode SDK dependency and supporting server package configuration;
- port `OpenCodeAdapter`, server-pool management, and event-mapping helpers from the stash;
- register OpenCode in the current adapter registry and provider service layers;
- align the OpenCode session start/input model to the current upstream provider start/session configuration contract;
- preserve current upstream provider abstractions for Codex and other reserved providers.

If the stash relied on older provider-start fields like direct `model`, `poolRoot`, or `providerOptions`, those responsibilities will either be mapped into the newer upstream session/config model or reintroduced only where they are still necessary for OpenCode to function.

### 3. Orchestration, Persistence, And Projection

OpenCode runtime events must survive the current orchestration path, which now projects provider behavior into domain events and persisted thread/session state.

Expected changes:

- port the stash changes in `ProviderRuntimeIngestion`, `ProviderCommandReactor`, projectors, and related tests that are necessary for OpenCode event ingestion;
- restore any persistence or projection updates needed for approvals, pending user input, proposed plans, or thread/session state derived from OpenCode events;
- keep the current queue-backed worker and receipt-driven synchronization model intact.

Only the pieces needed to make OpenCode behavior coherent in the present upstream architecture should land. Old stash internals that duplicate upstream responsibilities should stay out.

### 4. Web App And Native API

The web app will regain the OpenCode-facing user experience on top of current upstream UI/state flows.

Expected changes:

- reconnect provider queries and server config consumption where the current web app expects provider metadata;
- update provider picker/model picker/settings panels to expose OpenCode;
- restore pending user-input handling, approval flows, and any OpenCode-specific composer or timeline behavior needed for real sessions;
- port the stash updates to session logic, native API transport contracts, terminal drawer, and related tests;
- reintroduce any small supporting UI components only where they are still justified by the latest upstream structure.

If the stash references APIs that upstream removed, the web behavior will be rewritten against the current API surface instead of reviving stale transport methods unless that API is still required for a coherent provider UX.

### 5. Documentation

The published branch needs enough documentation for outside testers to understand the provider model and set up OpenCode.

Expected changes:

- port the stash updates to `.docs/architecture.md`, `.docs/provider-architecture.md`, `.docs/quick-start.md`, and `.docs/runtime-modes.md` where they remain accurate;
- restore or create a dedicated OpenCode prerequisites/setup document for practical tester onboarding;
- update top-level docs only where the branch behavior meaningfully changes what users must know.

## Execution Order

The implementation should proceed in this order:

1. Port contracts and shared model changes.
2. Port server provider integration and dependencies.
3. Port orchestration/persistence/projection changes.
4. Port web app and transport/settings changes.
5. Port documentation.
6. Run full verification and fix any regressions.

This order keeps the provider contract stable before the server depends on it, and keeps the server/event model stable before the web layer is adapted.

## Verification Strategy

Verification is a hard gate for this branch.

At minimum:

- focused tests should be run while porting each subsystem;
- the repo-wide completion gate is `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`;
- any new or restored behavior should be covered by automated tests wherever the stash previously had them or upstream has an established test pattern.

Because this is a cross-stack integration, a green repository baseline is required before calling the branch publishable.

## Risks And Mitigations

### Risk: stale stash architecture conflicts with upstream

Mitigation: treat stash code as behavioral reference, not as a patch to replay verbatim.

### Risk: partial OpenCode port compiles but breaks event flows at runtime

Mitigation: port the ingestion/projection and web pending-input flows together instead of landing only the adapter surface.

### Risk: settings and discovery drift creates a provider that exists in code but is unusable in UI

Mitigation: explicitly include provider settings, config transport, and web picker flows in scope for the first publishable version.

### Risk: docs lag behind behavior and outside testers cannot set up the branch

Mitigation: treat doc updates as part of the blocking publishable scope rather than an optional cleanup task.

## Documentation Impact

Documentation Impact: Update `.docs/architecture.md`, `.docs/provider-architecture.md`, `.docs/quick-start.md`, `.docs/runtime-modes.md`, and add or restore a dedicated OpenCode setup/prerequisites doc because provider behavior, setup workflow, and supported runtime surface will change.

## Done State

This design is complete when the repository contains a current-upstream-based OpenCode integration branch that:

- exposes OpenCode as a usable provider across contracts, server, and web layers;
- allows real tester-facing session flows, including approvals and pending user input;
- includes the necessary docs for setup and testing;
- passes the repository verification gauntlet.
