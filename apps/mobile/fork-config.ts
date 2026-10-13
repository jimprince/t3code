import type { ExpoConfig } from "expo/config";

export type MobileAppVariant = "development" | "preview" | "production";

export interface MobileForkConfig {
  readonly appleTeamId?: string | null;
  readonly iosBundleIdBase?: string | null;
  readonly androidPackageBase?: string | null;
  readonly schemeBase?: string | null;
  readonly easProjectId?: string | null;
  readonly easOwner?: string | null;
}

type ExpoPlugin = NonNullable<ExpoConfig["plugins"]>[number];

export function applyMobileForkConfig(upstream: ExpoConfig, fork: MobileForkConfig): ExpoConfig {
  const appVariant = resolveAppVariant(upstream.extra?.appVariant);
  const identifierSuffix =
    appVariant === "production" ? "" : appVariant === "development" ? ".dev" : ".preview";
  const schemeSuffix =
    appVariant === "production" ? "" : appVariant === "development" ? "-dev" : "-preview";
  const appleTeamId = nonEmpty(fork.appleTeamId);
  const iosBundleIdBase = nonEmpty(fork.iosBundleIdBase);
  const androidPackageBase = nonEmpty(fork.androidPackageBase);
  const schemeBase = nonEmpty(fork.schemeBase);
  const easProjectId = nonEmpty(fork.easProjectId);
  const easOwner = nonEmpty(fork.easOwner);
  const iosBundleIdentifier = iosBundleIdBase
    ? `${iosBundleIdBase}${identifierSuffix}`
    : upstream.ios?.bundleIdentifier;
  const androidPackage = androidPackageBase
    ? `${androidPackageBase}${identifierSuffix}`
    : upstream.android?.package;
  const extra = upstream.extra ?? {};
  const upstreamEas = isRecord(extra.eas) ? extra.eas : {};

  return {
    ...upstream,
    ...(schemeBase ? { scheme: `${schemeBase}${schemeSuffix}` } : {}),
    ...(appVariant === "development" ? { runtimeVersion: { policy: "fingerprint" as const } } : {}),
    ...(easProjectId
      ? {
          updates: {
            ...upstream.updates,
            url: `https://u.expo.dev/${easProjectId}`,
          },
        }
      : {}),
    ios: {
      ...upstream.ios,
      ...(iosBundleIdentifier ? { bundleIdentifier: iosBundleIdentifier } : {}),
      ...(appleTeamId ? { appleTeamId } : {}),
      ...(iosBundleIdBase && iosBundleIdentifier
        ? {
            entitlements: {
              ...upstream.ios?.entitlements,
              "keychain-access-groups": [`$(AppIdentifierPrefix)${iosBundleIdentifier}`],
            },
          }
        : {}),
    },
    android: {
      ...upstream.android,
      ...(androidPackage ? { package: androidPackage } : {}),
    },
    plugins: upstream.plugins?.map((plugin) =>
      applyExtensionIdentity(plugin, iosBundleIdBase ? iosBundleIdentifier : undefined),
    ),
    extra: {
      ...extra,
      ...(easProjectId
        ? {
            eas: {
              ...upstreamEas,
              projectId: easProjectId,
            },
          }
        : {}),
    },
    ...(easOwner ? { owner: easOwner } : {}),
  };
}

// Plugins derive native targets and EAS credential declarations from these identities.
function applyExtensionIdentity(
  plugin: ExpoPlugin,
  iosBundleIdentifier: string | undefined,
): ExpoPlugin {
  if (!iosBundleIdentifier || !Array.isArray(plugin)) {
    return plugin;
  }

  const options = isRecord(plugin[1]) ? plugin[1] : {};
  switch (plugin[0]) {
    case "expo-widgets":
      return [
        plugin[0],
        {
          ...options,
          bundleIdentifier: `${iosBundleIdentifier}.widgets`,
          groupIdentifier: `group.${iosBundleIdentifier}`,
        },
      ];
    case "expo-sharing":
      return [
        plugin[0],
        {
          ...options,
          ios: {
            ...(isRecord(options.ios) ? options.ios : {}),
            extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
            appGroupId: `group.${iosBundleIdentifier}`,
          },
        },
      ];
    default:
      return plugin;
  }
}

function resolveAppVariant(value: unknown): MobileAppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
