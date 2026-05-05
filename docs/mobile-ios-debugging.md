# Mobile iOS Pairing Debugging

This branch carries fork-local tooling that lets an agent drive the Expo iOS app
on a physical phone, pair it to the dev VM, and retrieve a structured app-state
snapshot without relying on screenshots.

The immediate target backend is:

- URL: `http://100.64.0.4:3773`
- Environment ID: `c9d5fd19-15d1-45f1-856d-3d05a939854d`
- Label: `brad-linux-dev`
- Dev bundle ID: `com.brad.t3code.dev`
- Dev scheme: `t3code-brad-dev`

## What Changed

The implementation is intentionally split into small fork-overlay pieces:

- `apps/mobile/src/lib/mobileDiagnostics.ts`
  - In-memory ring buffer for structured diagnostic events.
  - Redacts pairing credentials, bearer tokens, auth headers, and WebSocket
    tokens.
  - Writes `Documents/t3-mobile-debug-snapshot.json`.

- `apps/mobile/src/features/debug/useMobileDebugCommands.ts`
  - Installs a root-level debug command handler.
  - Handles both URL commands and an app-container command file fallback.
  - The file fallback is needed because `devicectl --payload-url` can be
    swallowed by the Expo dev client during launch/reload.

- `apps/mobile/src/features/debug/getMobileDebugSnapshot.ts`
  - Captures app variant, bundle/scheme, saved connections, runtime state,
    shell snapshot state, project/thread counts, and recent diagnostics.
  - Does not include bearer tokens or pairing tokens.

- `apps/mobile/scripts/ios-debug-control.mjs`
  - Host-side driver for physical-device testing.
  - Verifies VM descriptor, VM service, Metro, creates a fresh VM pairing token,
    sends the debug command to the app, requests a dump, copies the dump back,
    and validates the result.

- `apps/mobile/Makefile`
  - Adds:
    - `make ios-debug-vm-pair`
    - `make ios-debug-vm-pair-replace`
    - `make ios-debug-dump`
    - `make ios-debug-clear`
    - `make ios-debug-logs`

- `apps/mobile/src/features/connection/pairing.ts`
  - Accepts fork/dev schemes such as `t3code-brad-dev://...` when unwrapping
    encoded pairing URLs.

- `packages/client-runtime/src/wsTransport.ts` and related types
  - Adds an optional subscription `onError` callback so non-fatal stream errors
    such as unsupported terminal metadata subscription can be recorded in
    mobile diagnostics.

- `apps/mobile/src/state/use-remote-environment-registry.ts`
  - Treats shell snapshot bootstrap as the readiness source.
  - Subscribes to terminal metadata only after shell bootstrap succeeds, so
    older/local backends that reject `subscribeTerminalMetadata` can still
    connect and render projects/threads.

## How To Run The Phone Pairing Test

From `apps/mobile/`, start Metro for the development client:

```bash
APP_VARIANT=development CI=1 bunx expo start --dev-client --clear
```

In another shell:

```bash
make ios-debug-vm-pair
```

This preserves existing saved backends on the phone. Use
`make ios-debug-vm-pair-replace` only when intentionally testing a clean
single-backend state; it sends `replace=1` and clears saved connections such as
the MacBook backend.

Expected success output:

```text
Connection: ready
Projects: 7
Threads: 14
Debug dump: /var/folders/.../T/t3-mobile-debug/t3-mobile-debug-snapshot.json
```

The exact project/thread counts may change. The important checks are:

- saved connections include environment ID
  `c9d5fd19-15d1-45f1-856d-3d05a939854d`,
- runtime state is `ready`,
- shell snapshot is loaded,
- the snapshot file contains no auth secrets.

## Local MacBook Backend

The phone can also keep this MacBook backend saved alongside the VM backend.
Use the Mac's Tailscale URL so the phone does not depend on LAN addressing:

- URL: `http://100.64.0.2:3773`
- Environment ID: `5fa7c701-bf4d-496f-b753-55f77b4de905`
- Label: `Bradley’s MacBook Pro (4)`

Verified on May 3, 2026 through the Expo dev-client Metro path:

- saved connection count: 2
- VM runtime: `ready`, shell snapshot loaded, 8 projects, 15 threads
- Mac runtime: `ready`, shell snapshot loaded, 11 projects, 161 threads
- EAS development update group:
  `bfc4eb11-f72b-499e-bebb-145f519c21de`
- EAS update message:
  `mobile mac tailscale shell bootstrap 476cffc7d`

If the Mac runtime is stuck at `connecting` with `shellSnapshotPending: true`,
check whether terminal metadata subscription is being attempted before shell
bootstrap. The Mac fork build may reject `subscribeTerminalMetadata`; that must
remain diagnostic-only and must not block shell readiness.

## EAS Build And Update Status

The fork Expo project, OTA update channel, and EAS cloud iOS signing credentials
are configured. EAS cloud signing is separate from local Xcode signing. The old
WKWebView wrapper at
`/Users/brad/Programming/t3code-ios` can build locally with Xcode provisioning;
that does not mean EAS has credentials for Expo dev-client cloud builds.

Current fork EAS values:

- Project: `@jimprince/t3-code`
- Project ID: `c148e0df-ed1f-4673-9c07-403ea56b6d1b`
- Development bundle ID: `com.brad.t3code.dev`
- Development scheme: `t3code-brad-dev`
- Development channel: `development`
- Runtime version: `0.1.0`
- Apple team: `CBCQ6MJF4B`
- EAS iOS dev-client build: `545e2a20-54e7-47ec-9ed6-ecc70e89e47f`
- Latest verified update group: `bfc4eb11-f72b-499e-bebb-145f519c21de`

`EXPO_TOKEN` is expected in `/Users/brad/.shared/config/secrets.env` for
non-interactive EAS reads, updates, and build starts. Never print the token or
commit it to the repo.

GitHub Actions also needs an `EXPO_TOKEN` repository secret for
`.github/workflows/mobile-track-eas-update.yml`. On pushes to
`feature/mobile-track` that touch mobile/runtime inputs, that workflow runs
format, lint, typecheck, the focused thread-detail regression, and then publishes
an iOS EAS Update to the `development` channel. If that secret is missing, the
workflow fails before publishing.

EAS Update can ship JS/TS-only changes when the installed native dev client has
the same runtime version. Native dependency changes, native config changes, or
runtime-version changes require a new EAS build.

Verified on May 3, 2026:

- EAS credentials were created for `@jimprince/t3-code`
  / `com.brad.t3code.dev` with Apple team `CBCQ6MJF4B`.
- EAS development iOS build `545e2a20-54e7-47ec-9ed6-ecc70e89e47f` finished and
  installed on the connected iPhone as `com.brad.t3code.dev`.
- The branch was rebased onto `upstream/t3code/mobile-remote-connect` at
  `0385713da` so the mobile client contracts match the VM backend's current
  multi-provider contract shape.
- `make ios-debug-vm-pair` passed through the Expo dev-client Metro path:
  runtime state `ready`, shell snapshot loaded, 7 projects, 14 threads.
- Plain app launch did not apply the OTA update during this verification
  (`updateId` remained null), so physical-device acceptance used Metro:
  `APP_VARIANT=development CI=1 bunx expo start --dev-client --clear`.

Configure or inspect EAS iOS credentials interactively:

```bash
cd /Users/brad/Programming/t3-plugin/.worktrees/mobile-track/apps/mobile
set -a
source /Users/brad/.shared/config/secrets.env
set +a
APP_VARIANT=development npx eas-cli credentials -p ios
```

Create a development iOS dev-client build:

```bash
APP_VARIANT=development EXPO_NO_GIT_STATUS=1 npx eas-cli build --profile development -p ios --no-wait
```

Publish a JS/TS update to the development channel:

```bash
APP_VARIANT=development CI=1 EXPO_NO_GIT_STATUS=1 npx eas-cli update --channel development --environment development --platform ios --message "<message>"
```

Verify EAS build and update state:

```bash
APP_VARIANT=development CI=1 EXPO_NO_GIT_STATUS=1 npx eas-cli build:list --platform ios --limit 5 --json
APP_VARIANT=development CI=1 EXPO_NO_GIT_STATUS=1 npx eas-cli update:list --branch development --limit 5 --json
```

## Debug Command Channels

The app supports debug URLs in dev/fork builds:

```text
t3code-brad-dev://debug/pair?pairingUrl=<encoded>
t3code-brad-dev://debug/pair?pairingUrl=<encoded>&replace=1
t3code-brad-dev://debug/dump
t3code-brad-dev://debug/clear-connections
t3code-brad-dev://debug/disconnect?environmentId=<id>
t3code-brad-dev://debug/disconnect?all=1
```

The host script primarily uses the app-container command file:

```text
Documents/t3-mobile-debug-command.json
```

with this shape:

```json
{
  "id": "unique-command-id",
  "url": "t3code-brad-dev://debug/dump"
}
```

The app polls that file in dev/fork builds and runs new commands once.

Do not use `replace=1` for routine verification unless the test explicitly
requires clearing every saved backend.

## What The Snapshot Proves

The copied snapshot distinguishes these cases:

- no saved backend,
- saved backend exists but is disconnected,
- connected but no shell snapshot yet,
- shell snapshot loaded with zero projects/threads,
- shell snapshot loaded with real projects/threads,
- WebSocket/RPC/schema failures,
- stale saved Mac backend versus the dev VM backend.

## Thread Opening Spinner Triage

When the app gets stuck on `Opening thread...` after selecting a thread from a
connected server, separate shell-catalog state from per-thread detail state:

1. Verify the app build and JS source first.
   - Dev bundle ID should be `com.brad.t3code.dev`.
   - If using the dev client, start Metro from this worktree:
     `APP_VARIANT=development CI=1 bunx expo start --dev-client --clear`.
   - If relying on OTA, confirm `Updates.updateId` and channel in the debug
     snapshot; a plain app launch may keep `updateId` null.
2. Dump the device state:
   - `cd apps/mobile && make ios-debug-dump`
   - Check `savedConnections`, `runtime.state`, `shellSnapshotLoaded`,
     `projectCount`, and `threadCount`.
3. Interpret the route state:
   - Missing route params means Expo Router never supplied
     `environmentId/threadId`.
   - `runtime.state` of `connecting` or `reconnecting` means connection
     hydration is still blocking the route.
   - `runtime.state` of `ready` plus `shellSnapshotLoaded: true` but no matching
     thread means the shell catalog does not contain the route thread; the UI
     should show `Thread unavailable`.
   - A matching shell thread with no detail usually means
     `orchestration.subscribeThread` failed or never delivered a snapshot.
4. Check diagnostics for detail subscription failures:
   - `mobile.threadDetail.error` identifies a per-thread detail subscription
     failure and records the environment/thread IDs without secrets.
   - Backend `subscribeThread` can fail with `Thread <id> was not found` if the
     shell snapshot is stale or the server read model has no detail row.
   - Client/runtime schema mismatches also surface here as non-transport
     subscription errors.

Implementation note: `packages/client-runtime/src/threadDetailState.ts` must
convert non-retryable subscription errors into `ThreadDetailState.error` with
`isPending: false`. The mobile thread route must render that error instead of
leaving `selectedThreadDetail === null` on an infinite spinner. The focused
regression is `packages/client-runtime/src/threadDetailState.test.ts`.

Example successful VM state:

```json
{
  "savedConnections": [
    {
      "environmentId": "c9d5fd19-15d1-45f1-856d-3d05a939854d",
      "label": "brad-linux-dev",
      "httpBaseUrl": "http://100.64.0.4:3773/",
      "bearerTokenPresent": true
    }
  ],
  "runtime": [
    {
      "environmentId": "c9d5fd19-15d1-45f1-856d-3d05a939854d",
      "state": "ready",
      "shellSnapshotLoaded": true,
      "projectCount": 7,
      "threadCount": 14
    }
  ]
}
```

## Fork Persistence Policy

Keep this as a fork overlay while upstream mobile pairing/debuggability is still
insufficient for our physical-device workflow.

During each rebase onto `upstream/t3code/mobile-remote-connect`:

1. Prefer upstream implementations if they provide equivalent or better:
   - physical-device pairing automation,
   - app-side structured diagnostics,
   - secret-redacted state dump,
   - host-side command runner,
   - deterministic VM pairing verification.
2. If upstream adds equivalent debug surfaces, delete the fork-only files or
   shrink them to thin wrappers around upstream APIs.
3. If upstream changes connection/runtime internals, preserve behavior rather
   than exact code:
   - `make ios-debug-vm-pair` should still pair the phone to the VM,
   - the copied dump should still show backend identity, runtime state, shell
     snapshot state, and counts,
   - secrets should still be redacted.
4. Keep fork-specific values configurable through env/local config where
   possible. Do not commit tokens, EAS tokens, Apple credentials, or pairing
   credentials.

In short: this overlay is persistent on the fork, but intentionally disposable.
It should be superseded by upstream as soon as upstream gives us the same
observability and physical-device control.

## Known Notes

- `devicectl --payload-url` can launch the app but is not reliable for
  delivering commands to Expo Router/JS while the dev client is loading.
  The app-container command file is the reliable path.
- The VM has the T3 binary at `/home/brad/.local/node/bin/t3`; the helper sets
  PATH explicitly for non-interactive SSH.
- The helper waits for the dev bundle to load before sending commands. If Metro
  cache is cold, the first bundle can take around 10-15 seconds.
