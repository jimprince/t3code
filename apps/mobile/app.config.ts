// @effect-diagnostics nodeBuiltinImport:off - Expo evaluates app.config.ts in Node before the app runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { ExpoConfig } from "expo/config";

import forkConfig from "./fork.config.json";

type AppVariant = "development" | "preview" | "production";
type Environment = Readonly<Record<string, string | undefined>>;

type ForkConfig = {
  readonly appleTeamId?: string | null;
  readonly iosBundleIdBase?: string | null;
  readonly androidPackageBase?: string | null;
  readonly schemeBase?: string | null;
  readonly easProjectId?: string | null;
  readonly easOwner?: string | null;
};

const FORK: ForkConfig = forkConfig;
const UPSTREAM_EAS_PROJECT_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const UPSTREAM_EAS_OWNER = "pingdotgg";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const EAS_PROJECT_ID = nonEmpty(FORK.easProjectId) ?? UPSTREAM_EAS_PROJECT_ID;
const EAS_OWNER = nonEmpty(FORK.easOwner) ?? UPSTREAM_EAS_OWNER;
const APPLE_TEAM_ID = nonEmpty(FORK.appleTeamId);

const VARIANT_CONFIG: Record<
  AppVariant,
  {
    readonly appName: string;
    readonly scheme: string;
    readonly iosIcon: string;
    readonly iosBundleIdentifier: string;
    readonly androidPackage: string;
  }
> = {
  development: {
    appName: "T3 Code Dev",
    scheme: "t3code-dev",
    iosIcon: "./assets/icon-composer-dev.icon",
    iosBundleIdentifier: "com.t3tools.t3code.dev",
    androidPackage: "com.t3tools.t3code.dev",
  },
  preview: {
    appName: "T3 Code Preview",
    scheme: "t3code-preview",
    iosIcon: "./assets/icon-composer-prod.icon",
    iosBundleIdentifier: "com.t3tools.t3code.preview",
    androidPackage: "com.t3tools.t3code.preview",
  },
  production: {
    appName: "T3 Code",
    scheme: "t3code",
    iosIcon: "./assets/icon-composer-prod.icon",
    iosBundleIdentifier: "com.t3tools.t3code",
    androidPackage: "com.t3tools.t3code",
  },
};

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = applyForkOverrides(VARIANT_CONFIG[APP_VARIANT], APP_VARIANT);

const config: ExpoConfig = {
  name: variant.appName,
  slug: "t3-code",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: "0.1.0",
  runtimeVersion: {
    policy: process.env.MOBILE_VERSION_POLICY ?? "appVersion",
  },
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  updates: {
    enabled: true,
    url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  ios: {
    icon: variant.iosIcon,
    supportsTablet: true,
    bundleIdentifier: variant.iosBundleIdentifier,
    ...(APPLE_TEAM_ID ? { appleTeamId: APPLE_TEAM_ID } : {}),
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow T3 Code to connect to T3 Code servers on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    icon: "./assets/icon.png",
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-font",
    "expo-secure-store",
    ["@clerk/expo", { theme: "./clerk-theme.json" }],
    "expo-web-browser",
    [
      "expo-camera",
      {
        cameraPermission: "Allow T3 Code to access your camera so you can scan pairing QR codes.",
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: "./assets/splash-icon.png",
          backgroundColor: "#0a0a0a",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "18.0",
        },
      },
    ],
    [
      "expo-widgets",
      {
        bundleIdentifier: `${variant.iosBundleIdentifier}.widgets`,
        groupIdentifier: `group.${variant.iosBundleIdentifier}`,
        enablePushNotifications: true,
        widgets: [
          {
            name: "AgentActivity",
            displayName: "Agent Activity",
            description: "Shows the current state of active T3 Code agents.",
            supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
          },
        ],
      },
    ],
    "./plugins/withAndroidCleartextTraffic.cjs",
  ],
  extra: {
    appVariant: APP_VARIANT,
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    eas: {
      projectId: EAS_PROJECT_ID,
    },
  },
  owner: EAS_OWNER,
};

function applyForkOverrides(
  base: (typeof VARIANT_CONFIG)[AppVariant],
  appVariant: AppVariant,
): (typeof VARIANT_CONFIG)[AppVariant] {
  const variantSlug =
    appVariant === "production" ? "" : appVariant === "development" ? ".dev" : ".preview";
  const schemeSlug =
    appVariant === "production" ? "" : appVariant === "development" ? "-dev" : "-preview";

  const iosBundleIdBase = nonEmpty(FORK.iosBundleIdBase);
  const androidPackageBase = nonEmpty(FORK.androidPackageBase);
  const schemeBase = nonEmpty(FORK.schemeBase);

  return {
    ...base,
    iosBundleIdentifier: iosBundleIdBase
      ? `${iosBundleIdBase}${variantSlug}`
      : base.iosBundleIdentifier,
    androidPackage: androidPackageBase
      ? `${androidPackageBase}${variantSlug}`
      : base.androidPackage,
    scheme: schemeBase ? `${schemeBase}${schemeSlug}` : base.scheme,
  };
}

function nonEmpty(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function loadRepoEnv({ baseEnv = process.env }: { readonly baseEnv?: Environment } = {}): Record<
  string,
  string | undefined
> {
  const repoRoot = NodePath.resolve(process.cwd(), "../..");
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const publicConfig = resolvePublicConfig(baseEnv, localEnv, rootEnv);

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    ...(publicConfig.clerkPublishableKey
      ? {
          T3CODE_CLERK_PUBLISHABLE_KEY: publicConfig.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: publicConfig.clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: publicConfig.clerkPublishableKey,
        }
      : {}),
    ...(publicConfig.clerkJwtTemplate
      ? {
          T3CODE_CLERK_JWT_TEMPLATE: publicConfig.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: publicConfig.clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: publicConfig.clerkJwtTemplate,
        }
      : {}),
    ...(publicConfig.relayUrl
      ? {
          T3CODE_RELAY_URL: publicConfig.relayUrl,
          VITE_T3CODE_RELAY_URL: publicConfig.relayUrl,
        }
      : {}),
  };
}

function resolvePublicConfig(...sources: readonly Environment[]) {
  return {
    clerkPublishableKey: firstNonEmpty(
      sources,
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "T3CODE_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
      "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    ),
    relayUrl: firstNonEmpty(sources, "T3CODE_RELAY_URL", "VITE_T3CODE_RELAY_URL"),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}

export default config;
