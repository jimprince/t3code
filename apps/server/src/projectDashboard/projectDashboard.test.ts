import * as NodeServices from "@effect/platform-node/NodeServices";
import type { GiteaInstanceConfig } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import {
  EMPTY_DASHBOARD_FILE,
  normalizeWidgets,
  parseDashboardFile,
  resolveTrackerSetting,
} from "./projectDashboard.logic.ts";
import * as ProjectDashboardStore from "./ProjectDashboardStore.ts";

const instance = (id: string, webOrigin: string): GiteaInstanceConfig => ({
  id,
  host: new URL(webOrigin).hostname,
  sshAliases: [],
  sshPorts: [22],
  webOrigin,
  apiOrigin: webOrigin,
  token: "",
});
const home = instance("home", "http://git.home:3000");
const public_ = instance("public", "https://git.bradleyprince.com");

describe("dashboard settings", () => {
  it("normalizes widget ids and ignores a malformed file", () => {
    expect(normalizeWidgets([" Requests", "release", "requests", "", "roadmap"])).toEqual([
      "requests",
      "release",
      "roadmap",
    ]);
    expect(parseDashboardFile("{not json")).toEqual(EMPTY_DASHBOARD_FILE);
    expect(parseDashboardFile('{"version":2}')).toEqual(EMPTY_DASHBOARD_FILE);
  });

  it("resolves an explicit tracker by owner/repo or by repository URL", () => {
    expect(resolveTrackerSetting("brad/t3code-fork", [home, public_])).toMatchObject({
      instance: { id: "home" },
      repository: "brad/t3code-fork",
    });
    expect(
      resolveTrackerSetting("https://git.bradleyprince.com/brad/T3code-Fork.git", [home, public_]),
    ).toMatchObject({ instance: { id: "public" }, repository: "brad/t3code-fork" });
    expect(resolveTrackerSetting("https://github.com/jimprince/t3code", [home])).toBeNull();
    expect(resolveTrackerSetting("brad/t3code-fork", [])).toBeNull();
  });
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-dashboard-store-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("dashboard store", (it) => {
  it.effect("persists widget order and tracker across store instances", () =>
    Effect.gen(function* () {
      const writer = yield* ProjectDashboardStore.make;
      yield* writer.modify((file) => ({
        ...file,
        dashboards: { "root-1": { widgets: ["requests", "release", "canvas"] } },
        trackers: { "project-1": "brad/t3code-fork" },
      }));
      const reader = yield* ProjectDashboardStore.make;
      const file = yield* reader.read;
      expect(file.dashboards["root-1"]?.widgets).toEqual(["requests", "release", "canvas"]);
      expect(file.trackers["project-1"]).toBe("brad/t3code-fork");
    }),
  );

  it.effect("persists the health line per root thread", () =>
    Effect.gen(function* () {
      const health = {
        status: "at-risk",
        sentence: "V2 port waiting on plan approval",
        updatedAt: "2026-10-05T12:00:00.000Z",
        threadId: "root-2",
      };
      const writer = yield* ProjectDashboardStore.make;
      yield* writer.modify((file) => ({ ...file, health: { "root-2": health } }));
      const file = yield* (yield* ProjectDashboardStore.make).read;
      expect(file.health["root-2"]).toEqual(health);
      expect(parseDashboardFile('{"version":1}').health).toEqual({});
    }),
  );
});
