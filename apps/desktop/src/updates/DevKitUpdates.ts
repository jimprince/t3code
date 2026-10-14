// @effect-diagnostics nodeBuiltinImport:off -- The Mac dev kit is driven through its own shell script.
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

/**
 * T3 Code (Dev) on Brad's Mac is the fork's `vp run dev:desktop` app, installed and kept current
 * by the t3-mac-dev kit (`~/t3-mac-dev`, checkout `~/Developer/t3code-dev`). Its update button
 * reuses the kit's two entry points instead of electron-updater: `dev-launch.sh --status`
 * (read-only, fetches origin) answers Check, and `dev-launch.sh` (the Dock click handler, which
 * kicks the kit's update LaunchAgent) answers Update.
 */
export interface DevKit {
  readonly script: string;
}

export class DevKitUpdateError extends Schema.TaggedError<DevKitUpdateError>()(
  "DevKitUpdateError",
  { message: Schema.String },
) {}

export interface DevKitStatus {
  /** Short SHA of the kit checkout, the commit this app was last built from. */
  readonly builtSha: string;
  /** Short SHA of the followed branch's tip on origin. */
  readonly liveSha: string;
  readonly branch: string;
  readonly needsUpdate: boolean;
  readonly workerRunning: boolean;
}

/** Only the kit's own app qualifies: a dev app from any other checkout must not rebuild the kit's. */
export const resolve = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<Option.Option<DevKit>> =>
  Effect.gen(function* () {
    const { path, homeDirectory } = environment;
    if (
      environment.platform !== "darwin" ||
      !environment.isDevelopment ||
      environment.rootDir !== path.join(homeDirectory, "Developer", "t3code-dev")
    ) {
      return Option.none<DevKit>();
    }
    const script = path.join(homeDirectory, "t3-mac-dev", "dev-launch.sh");
    return (yield* fileSystem.exists(script).pipe(Effect.orElseSucceed(() => false)))
      ? Option.some({ script })
      : Option.none<DevKit>();
  });

/** Reads the output of `dev-launch.sh --status`; null when it is not that output. */
export function parseDevKitStatus(output: string): (DevKitStatus & { fetched: boolean }) | null {
  const followed = output.match(/^branch followed:\s+(\S+)\s+fetched:\s+(\S+)/m);
  const built = output.match(/^checkout:\s+([0-9a-f]+)/m);
  const live = output.match(/^origin\/\S+:\s+([0-9a-f]+)/m);
  const needs = output.match(/^needs update:\s+(yes|no)/m);
  const worker = output.match(/update worker:\s+(\w+)/);
  if (!followed || !built || !live || !needs) return null;
  return {
    branch: followed[1]!,
    fetched: followed[2] === "yes",
    builtSha: built[1]!,
    liveSha: live[1]!,
    needsUpdate: needs[1] === "yes",
    workerRunning: worker?.[1] === "running",
  };
}

/** The state the button shows for one status reading; both SHAs are in the message. */
export function reduceStateOnDevKitStatus(
  state: DesktopUpdateState,
  status: DevKitStatus,
  checkedAt: string,
): DesktopUpdateState {
  if (status.needsUpdate) {
    return {
      ...reduceDesktopUpdateStateOnUpdateAvailable(state, status.liveSha, checkedAt),
      message: `origin/${status.branch} is at ${status.liveSha}, ahead of this build (${status.builtSha}).`,
    };
  }
  return {
    ...reduceDesktopUpdateStateOnNoUpdate(state, checkedAt),
    message: `Up to date: origin/${status.branch} is at ${status.liveSha}, the commit this build was made from.`,
  };
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const runKit = (kit: DevKit, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => execFile("/bin/bash", [kit.script, ...args], { timeout: 60_000 }),
    catch: (cause) =>
      new DevKitUpdateError({
        message: `The dev kit script failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

export const readStatus = (kit: DevKit): Effect.Effect<DevKitStatus, DevKitUpdateError> =>
  runKit(kit, ["--status"]).pipe(
    Effect.flatMap(({ stdout }) => {
      const status = parseDevKitStatus(stdout);
      if (status === null) {
        return Effect.fail(
          new DevKitUpdateError({ message: "The dev kit status was unreadable." }),
        );
      }
      return status.fetched
        ? Effect.succeed(status)
        : Effect.fail(
            new DevKitUpdateError({
              message: `Could not reach origin/${status.branch}; check the network and try again.`,
            }),
          );
    }),
  );

/** Asks the kit's update LaunchAgent to pull, rebuild and relaunch; returns once it is accepted. */
export const requestUpdate = (kit: DevKit): Effect.Effect<void, DevKitUpdateError> =>
  runKit(kit, []).pipe(Effect.asVoid);
