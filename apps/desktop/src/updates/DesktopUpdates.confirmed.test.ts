import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.effect(
  "runs every update phase from one confirmed action and publishes bytes before restarting",
  () => {
    const harness = makeHarness({
      checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
      downloadUpdate: Effect.sync(() => {
        harness.emit("download-progress", { percent: 100, transferred: 2048, total: 2048 });
        harness.emit("update-downloaded", { version: "1.2.4" });
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* updates.startUpdate;
        expect(result.accepted).toBe(true);
        expect(harness.checkCount()).toBe(1);
        expect(harness.downloadCount()).toBe(1);
        expect(harness.quitAndInstallCount()).toBe(1);
        expect(harness.sentStates.find((state) => state.updatePhase === "verifying")).toMatchObject(
          { downloadTransferredBytes: 2048, downloadTotalBytes: 2048, downloadPercent: 100 },
        );
        expect(harness.sentStates.map((state) => state.updatePhase)).toEqual(
          expect.arrayContaining([
            "checking",
            "downloading",
            "verifying",
            "installing",
            "restarting",
          ]),
        );
      }),
    ).pipe(Effect.provide(harness.layer));
  },
);

it.effect("keeps a verified download and exposes the install failure for a one-click retry", () => {
  let failInstall = true;
  const harness = makeHarness({
    checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
    downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.4" })),
    quitAndInstall: Effect.suspend(() =>
      failInstall
        ? Effect.fail(
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: "latest",
              isSilent: true,
              isForceRunAfter: true,
              cause: new Error("installer refused"),
            }),
          )
        : Effect.void,
    ),
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const failed = yield* updates.startUpdate;
      expect(failed.state).toMatchObject({
        downloadedVersion: "1.2.4",
        canRetry: true,
        errorContext: "install",
      });
      expect(failed.state.message).toBeTruthy();
      failInstall = false;
      const retried = yield* updates.startUpdate;
      expect(retried.accepted).toBe(true);
      expect(harness.quitAndInstallCount()).toBe(2);
      expect(harness.downloadCount()).toBe(1);
    }),
  ).pipe(Effect.provide(harness.layer));
});
