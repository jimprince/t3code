import type { ExpoConfig } from "expo/config";
import { describe, expect, it } from "vite-plus/test";

import mobileConfig from "./app.config";
import { applyMobileForkConfig, type MobileForkConfig } from "./fork-config";

const forkConfig: MobileForkConfig = {
  appleTeamId: "FORKTEAM",
  iosBundleIdBase: "com.example.fork",
  androidPackageBase: "com.example.fork",
  schemeBase: "example-fork",
  easProjectId: "fork-project-id",
  easOwner: "fork-owner",
};

function makeUpstreamConfig(appVariant: "development" | "preview" | "production"): ExpoConfig {
  const suffix =
    appVariant === "production" ? "" : `.${appVariant === "development" ? "dev" : "preview"}`;

  return {
    name: "Upstream Mobile",
    slug: "upstream-mobile",
    scheme: "upstream",
    runtimeVersion: { policy: "fingerprint" },
    updates: {
      enabled: true,
      url: "https://u.expo.dev/upstream-project-id",
      checkAutomatically: "ON_LOAD",
    },
    ios: {
      appleTeamId: "UPSTREAMTEAM",
      bundleIdentifier: `com.upstream.mobile${suffix}`,
      associatedDomains: ["applinks:upstream.example"],
      infoPlist: { UpstreamSentinel: true },
    },
    android: {
      package: `com.upstream.mobile${suffix}`,
      predictiveBackGestureEnabled: true,
    },
    plugins: [
      "expo-asset",
      ["expo-font", { ios: { fonts: ["Upstream.ttf"] } }],
      "expo-sqlite",
      [
        "expo-widgets",
        {
          bundleIdentifier: `com.upstream.mobile${suffix}.widgets`,
          groupIdentifier: `group.com.upstream.mobile${suffix}`,
          frequentUpdates: true,
          widgets: [{ name: "UpstreamWidget" }],
        },
      ],
      "./plugins/withIosCocoaPodsUuidCache.cjs",
      "./plugins/withIosSceneLifecycle.cjs",
    ],
    extra: {
      appVariant,
      iosPersonalTeamBuild: false,
      upstreamSentinel: { preserved: true },
      eas: { projectId: "upstream-project-id" },
    },
    owner: "upstream-owner",
  };
}

describe("applyMobileForkConfig", () => {
  it("exports fork identity with upstream production plugins and entitlements intact", () => {
    const plugins = mobileConfig.plugins ?? [];
    const pluginNames = plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    const widgetOptions = plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-widgets",
    )?.[1];
    const buildProperties = plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-build-properties",
    )?.[1];

    expect(mobileConfig).toMatchObject({
      owner: "jimprince",
      scheme: "t3code-brad",
      runtimeVersion: { policy: "appVersion" },
      updates: { url: "https://u.expo.dev/c148e0df-ed1f-4673-9c07-403ea56b6d1b" },
      ios: {
        appleTeamId: "CBCQ6MJF4B",
        bundleIdentifier: "com.brad.t3code",
        associatedDomains: ["applinks:clerk.t3.codes", "webcredentials:clerk.t3.codes"],
      },
      android: {
        package: "com.brad.t3code",
        predictiveBackGestureEnabled: true,
      },
      extra: {
        eas: { projectId: "c148e0df-ed1f-4673-9c07-403ea56b6d1b" },
      },
    });
    expect(pluginNames).toEqual(
      expect.arrayContaining([
        "expo-asset",
        "expo-font",
        "expo-sqlite",
        "expo-quick-actions",
        "expo-widgets",
        "./plugins/withIosCocoaPodsUuidCache.cjs",
        "./plugins/withIosSceneLifecycle.cjs",
      ]),
    );
    expect(widgetOptions).toMatchObject({
      bundleIdentifier: "com.brad.t3code.widgets",
      groupIdentifier: "group.com.brad.t3code",
      frequentUpdates: true,
    });
    expect(buildProperties).toMatchObject({
      ios: {
        deploymentTarget: "18.0",
        extraPods: [
          { name: "GoogleUtilities", modular_headers: true },
          { name: "RecaptchaInterop", modular_headers: true },
        ],
      },
    });
  });

  it("overlays fork identity while preserving upstream native configuration", () => {
    const upstream = makeUpstreamConfig("development");
    const result = applyMobileForkConfig(upstream, forkConfig);

    expect(result).toMatchObject({
      name: "Upstream Mobile",
      slug: "upstream-mobile",
      scheme: "example-fork-dev",
      runtimeVersion: { policy: "fingerprint" },
      updates: {
        enabled: true,
        url: "https://u.expo.dev/fork-project-id",
        checkAutomatically: "ON_LOAD",
      },
      ios: {
        appleTeamId: "FORKTEAM",
        bundleIdentifier: "com.example.fork.dev",
        associatedDomains: ["applinks:upstream.example"],
        infoPlist: { UpstreamSentinel: true },
      },
      android: {
        package: "com.example.fork.dev",
        predictiveBackGestureEnabled: true,
      },
      extra: {
        appVariant: "development",
        iosPersonalTeamBuild: false,
        upstreamSentinel: { preserved: true },
        eas: { projectId: "fork-project-id" },
      },
      owner: "fork-owner",
    });
    expect(result.plugins).toEqual([
      "expo-asset",
      ["expo-font", { ios: { fonts: ["Upstream.ttf"] } }],
      "expo-sqlite",
      [
        "expo-widgets",
        {
          bundleIdentifier: "com.example.fork.dev.widgets",
          groupIdentifier: "group.com.example.fork.dev",
          frequentUpdates: true,
          widgets: [{ name: "UpstreamWidget" }],
        },
      ],
      "./plugins/withIosCocoaPodsUuidCache.cjs",
      "./plugins/withIosSceneLifecycle.cjs",
    ]);
  });

  it.each([
    ["development", ".dev", "-dev", "fingerprint"],
    ["preview", ".preview", "-preview", "appVersion"],
    ["production", "", "", "appVersion"],
  ] as const)(
    "uses the fork identity and runtime policy for %s",
    (appVariant, identifierSuffix, schemeSuffix, runtimePolicy) => {
      const result = applyMobileForkConfig(makeUpstreamConfig(appVariant), forkConfig);

      expect(result.ios?.bundleIdentifier).toBe(`com.example.fork${identifierSuffix}`);
      expect(result.android?.package).toBe(`com.example.fork${identifierSuffix}`);
      expect(result.scheme).toBe(`example-fork${schemeSuffix}`);
      expect(result.runtimeVersion).toEqual({ policy: runtimePolicy });
    },
  );

  it("leaves upstream identity unchanged when an optional fork override is absent", () => {
    const upstream = makeUpstreamConfig("production");
    const result = applyMobileForkConfig(upstream, {});

    expect(result.ios).toEqual(upstream.ios);
    expect(result.android).toEqual(upstream.android);
    expect(result.scheme).toBe(upstream.scheme);
    expect(result.updates).toEqual(upstream.updates);
    expect(result.extra).toEqual(upstream.extra);
    expect(result.owner).toBe(upstream.owner);
  });
});
