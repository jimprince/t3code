import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

// Reuse the suite's git executor and process port so template and tip reads
// exercise the same repository and mocks as the configured provider.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const process = yield* VcsProcess.VcsProcess;
    return TestSourceControlHost.layer({
      git: { execute: git.execute, resolveCommit: git.resolveCommit },
      process: { run: process.run },
    });
  }),
);
