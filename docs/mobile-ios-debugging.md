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

## How To Run The Phone Pairing Test

From `apps/mobile/`, start Metro for the development client:

```bash
APP_VARIANT=development CI=1 bunx expo start --dev-client --clear
```

In another shell:

```bash
make ios-debug-vm-pair
```

Expected success output:

```text
Connection: ready
Projects: 7
Threads: 14
Debug dump: /var/folders/.../T/t3-mobile-debug/t3-mobile-debug-snapshot.json
```

The exact project/thread counts may change. The important checks are:

- saved connection environment ID is `c9d5fd19-15d1-45f1-856d-3d05a939854d`,
- runtime state is `ready`,
- shell snapshot is loaded,
- the snapshot file contains no auth secrets.

## EAS Build And Update Status

The fork Expo project and OTA update channel are configured, but EAS cloud iOS
signing is separate from local Xcode signing. The old WKWebView wrapper at
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

`EXPO_TOKEN` is expected in `/Users/brad/.shared/config/secrets.env` for
non-interactive EAS reads, updates, and build starts. Never print the token or
commit it to the repo.

EAS Update can ship JS/TS-only changes when the installed native dev client has
the same runtime version. Native dependency changes, native config changes, or
runtime-version changes require a new EAS build.

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

## What The Snapshot Proves

The copied snapshot distinguishes these cases:

- no saved backend,
- saved backend exists but is disconnected,
- connected but no shell snapshot yet,
- shell snapshot loaded with zero projects/threads,
- shell snapshot loaded with real projects/threads,
- WebSocket/RPC/schema failures,
- stale saved Mac backend versus the dev VM backend.

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
