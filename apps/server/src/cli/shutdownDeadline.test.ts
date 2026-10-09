import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

it.layer(NodeServices.layer)("CLI shutdown ceiling", (it) => {
  it.effect("exits after SIGTERM even when graceful teardown never completes", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const moduleUrl = new URL("./shutdownDeadline.ts", import.meta.url).href;
      const child = yield* spawner.spawn(
        ChildProcess.make("node", [
          "--input-type=module",
          "-e",
          `
        const { installShutdownDeadline } = await import(process.argv[1]);
        installShutdownDeadline(50);
        process.on("SIGTERM", () => {});
        process.stdout.write("ready\\n");
        setInterval(() => {}, 1000);
      `,
          moduleUrl,
        ]),
      );
      const ready = yield* child.stdout.pipe(Stream.runHead);
      assert.isTrue(Option.isSome(ready));
      assert.include(new TextDecoder().decode(Option.getOrThrow(ready)), "ready");
      yield* child.kill({ killSignal: "SIGTERM" });
      assert.equal(yield* child.exitCode, 1);
      const stderr = yield* child.stderr.pipe(Stream.runCollect);
      assert.include(
        stderr.map((chunk) => new TextDecoder().decode(chunk)).join(""),
        "shutdown deadline exceeded",
      );
    }),
  );
});
