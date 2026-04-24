import type { DesktopUpdateChannel } from "@t3tools/contracts";

// Accepts both:
//   - direct nightly versions: `0.0.21-nightly.20260421.88`
//     (workflow_dispatch-generated)
//   - fork nightlies published by sync-upstream:
//     `0.0.21-nightly.20260421.88-fork.1`
// The fork suffix is optional so installed clients on either variant resolve
// to the `nightly` update channel.
const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+(?:-fork\.\d+)?$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}

export function doesVersionMatchDesktopUpdateChannel(
  version: string,
  channel: DesktopUpdateChannel,
): boolean {
  return resolveDefaultDesktopUpdateChannel(version) === channel;
}
