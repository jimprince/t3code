# iOS Deployment Options

Git stores and transports the source code. A GitHub or Gitea push can also
trigger a build runner, but Git does not install an app on an iPhone by itself.
Every physical-device install still needs an Apple-signed app and a provisioning
method accepted by iOS.

For Brad's single-app setup, prefer the `production` variant
(`com.brad.t3code`). Its on-device name is **T3 Code** and its App Store Connect
record is **T3 Code - Fork**. Avoid installing the side-by-side `development`
and `preview` variants unless they are specifically needed for debugging.

## Choose a path

| Path                            | Apple/TestFlight upload | Installs remotely                          | Expiration                               | Best use                                                    |
| ------------------------------- | ----------------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| Local Xcode install             | No                      | No; the iPhone must be paired with the Mac | Provisioning must remain valid           | Fast personal deployment from a Git checkout                |
| EAS internal/ad hoc             | No                      | Yes, through an EAS install link           | Provisioning must remain valid           | A small registered-device test group                        |
| TestFlight                      | Yes                     | Yes                                        | Each build is testable for up to 90 days | Private beta use without pairing the phone to the build Mac |
| App Store or unlisted App Store | Yes, plus App Review    | Yes                                        | No beta-build expiration                 | Durable installation and normal App Store updates           |
| EAS OTA update                  | No new binary           | Yes, to an existing compatible install     | Follows the installed binary             | JavaScript/assets-only updates between native builds        |

## 1. Install directly from a local Git checkout

This is the shortest path when the iPhone is available to the Mac. Xcode builds,
signs, and installs the app over USB or paired Wi-Fi; neither TestFlight nor an
App Store listing is involved.

```bash
git pull --ff-only
cd apps/mobile
vp run ios:release
```

Select the physical iPhone when Expo/Xcode asks for a destination. The production
release is self-contained and does not need Metro. For interactive debugging,
use `vp run ios:dev`, which installs the separate `T3 Code Dev` variant and does
need the development client workflow described in
[`apps/mobile/README.md`](../../apps/mobile/README.md).

Xcode automatic signing still needs an Apple account/team, a registered device,
Developer Mode on the iPhone, and a valid development provisioning profile.
Apple documents the profile requirements in
[Create a development provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-a-development-provisioning-profile/).

A Gitea workflow can automate the same shape on a trusted Mac runner:

```text
Gitea push -> Mac runner checks out commit -> Xcode builds/signs -> paired iPhone install
```

That runner and device-install job are **not configured in this repository**.
The current T3 Code mobile automation runs on GitHub Actions/EAS. A future Gitea
job would still require the Mac's signing identity, provisioning profile, and a
reachable paired iPhone.

## 2. Install an EAS internal/ad-hoc build

The `development`, `preview`, and `preview:dev` EAS profiles use internal
distribution. EAS produces an ad-hoc-signed IPA and an install link. Only device
UDIDs included in the provisioning profile can install the app.

```bash
cd apps/mobile
vp run eas:ios:dev
vp run eas:ios:preview
```

Register a new device with `eas device:create`, then rebuild or re-sign so its
UDID is included. See Expo's
[internal distribution guide](https://docs.expo.dev/build/internal-distribution/).
These profiles intentionally use separate app variants, so they are not the
preferred path when the goal is exactly one production app on the phone.

## 3. Deploy the production build through TestFlight

This is the repository's current remote-install path. CI creates the production
IPA on EAS, then a separate macOS job uploads that exact completed build to App
Store Connect. Keeping build and upload separate prevents duplicate submissions.

Start a production build:

```bash
gh workflow run mobile-eas-production.yml --repo jimprince/t3code \
  -f mode=build \
  -f platform=ios
```

After EAS reports a finished iOS build, upload it using its EAS build ID:

```bash
gh workflow run mobile-eas-production.yml --repo jimprince/t3code \
  -f mode=submit \
  -f platform=ios \
  -f build_id=<eas-build-id>
```

App Store Connect processes the upload; then assign it to the internal testing
group and install it through TestFlight. Internal TestFlight builds remain
available for 90 days. See Apple's
[TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).

The detailed signing/bootstrap procedure and current App Store Connect record
are in [`docs/operations/release.md`](../operations/release.md#production-build-lane).

## 4. Release through the App Store

The App Store uses the same production bundle ID and uploaded build as the
TestFlight path. Complete the product-page metadata, screenshots, privacy
answers, review information, and availability settings in App Store Connect,
then submit the build to App Review.

- **Public:** searchable in the selected App Store regions.
- **Unlisted:** accessible by direct link but absent from search, charts, and
  categories. The app must still be review-ready and pass App Review before
  Apple grants unlisted distribution.

An approved App Store build gives the most durable single-app installation and
normal App Store updates. See Apple's
[unlisted app distribution](https://developer.apple.com/support/unlisted-app-distribution/)
and [distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods/).

## 5. Publish an EAS OTA update

An OTA update is not a fresh installation. It updates JavaScript and bundled
assets inside an already installed production binary whose runtime version is
compatible.

```bash
gh workflow run mobile-eas-production.yml --repo jimprince/t3code \
  -f mode=update \
  -f platform=ios \
  -f message="describe the production update"
```

Use a new native build instead when a change touches native modules, Expo/native
configuration, entitlements, signing, the widget target, or any other input that
changes the native runtime. Do not use OTA updates to bypass that compatibility
boundary.
