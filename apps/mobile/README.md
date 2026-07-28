# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is still in development. The fork has a production build path,
> but it is not a public App Store release.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

For the differences between local Xcode installs, EAS internal/ad-hoc builds,
TestFlight, App Store distribution, and EAS OTA updates, see
[`docs/mobile/ios-deployment.md`](../../docs/mobile/ios-deployment.md). That guide
also explains why GitHub or Gitea can trigger a deployment but cannot replace
iOS code signing and provisioning.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

This fork resolves its EAS owner/project and app identifiers from
`fork.config.json`. The tracked values are non-secret and point development
updates at Brad's `jimprince/t3-code` EAS project while preserving upstream's
mobile app code on `main`.

Native configuration follows the same rule. `app.config.ts` remains upstream's
configuration and applies the identity/EAS overrides from `fork-config.ts` only
at export. Keep upstream plugins, entitlements, assets, and platform settings in
that config; fork changes belong in the small overlay. This structure lets Git
carry upstream edits through scheduled rebases instead of replaying a stale
fork-owned copy of the whole Expo config.

CI uses Expo fingerprinting for development and preview dev-client builds to reuse an existing compatible build when possible, or start a new internal EAS build when native runtime inputs change. Production and persistent preview builds continue to use the `appVersion` runtime policy.

`fingerprint.config.cjs` normalizes Expo/RN autolinking config paths before
hashing. pnpm store directories include peer dependency hash suffixes that can
differ between the Linux GitHub runner and EAS macOS builders even when the
resolved packages are identical. The fingerprint keeps hashing the native
package identities and config contents, but rewrites paths like
`node_modules/.pnpm/<store>/node_modules/<pkg>` to stable `node_modules/<pkg>`
form so the build runtime version and OTA update runtime version agree across
machines.

The `@clerk/expo` patch normalizes Clerk's generated iOS app bridge to use
`internal import ClerkExpo`, matching Expo's generated Swift imports on Xcode 26
and avoiding mixed import access levels for the `ClerkExpo` module.

`Mobile EAS Development Update` is retained as a manual-only legacy recovery
lane. Normal mobile deployment uses the single production workflow documented
in [`docs/operations/release.md`](../../docs/operations/release.md#production-build-lane).
If the development workflow is explicitly dispatched, it only publishes an OTA
update after EAS has a `FINISHED` iOS development build whose runtime version
matches the current iOS fingerprint. The iOS app has a widget extension, so ad
hoc credentials exist for both `com.brad.t3code.dev` and
`com.brad.t3code.dev.widgets`. CI consumes signing credentials stored on EAS
servers. When the native fingerprint changes and stored credentials are missing
or expired, refresh them with one interactive local build (Apple ID auth):

```bash
cd apps/mobile
APP_VARIANT=development eas build --profile development --platform ios
```

Manual dispatch is also supported from
`.github/workflows/mobile-eas-development.yml`.

If an incompatible development OTA update is published, use
`.github/workflows/mobile-eas-development-rollback.yml` to roll the affected
runtime version back to the embedded bundle.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
