import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { t3ThreadIdentityEnv, withT3ThreadIdentityEnv } from "./t3ThreadIdentityEnv.ts";

function withProcessEnvironmentMetadata<A>(
  metadata: { readonly id?: string; readonly name?: string },
  run: () => A,
): A {
  const previousId = process.env.T3_ENVIRONMENT_ID;
  const previousName = process.env.T3_ENVIRONMENT_NAME;
  const restore = (key: "T3_ENVIRONMENT_ID" | "T3_ENVIRONMENT_NAME", value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("T3_ENVIRONMENT_ID", metadata.id);
  restore("T3_ENVIRONMENT_NAME", metadata.name);
  try {
    return run();
  } finally {
    restore("T3_ENVIRONMENT_ID", previousId);
    restore("T3_ENVIRONMENT_NAME", previousName);
  }
}

describe("t3ThreadIdentityEnv", () => {
  it("always carries the thread id, with or without environment metadata", () => {
    withProcessEnvironmentMetadata({}, () => {
      expect(t3ThreadIdentityEnv({ threadId: ThreadId.make("thread-1") })).toEqual({
        T3_THREAD_ID: "thread-1",
      });
    });
  });

  it("falls back to the server's process-level environment metadata", () => {
    withProcessEnvironmentMetadata({ id: "environment-process", name: "process-env" }, () => {
      expect(t3ThreadIdentityEnv({ threadId: ThreadId.make("thread-1") })).toEqual({
        T3_THREAD_ID: "thread-1",
        T3_ENVIRONMENT_ID: "environment-process",
        T3_ENVIRONMENT_NAME: "process-env",
      });
    });
  });

  it("prefers an explicit environment over the process-level metadata", () => {
    withProcessEnvironmentMetadata({ id: "environment-process", name: "process-env" }, () => {
      expect(
        t3ThreadIdentityEnv({
          threadId: ThreadId.make("thread-1"),
          environmentId: EnvironmentId.make("environment-explicit"),
          environmentName: "explicit-env",
        }),
      ).toEqual({
        T3_THREAD_ID: "thread-1",
        T3_ENVIRONMENT_ID: "environment-explicit",
        T3_ENVIRONMENT_NAME: "explicit-env",
      });
    });
  });
});

describe("withT3ThreadIdentityEnv", () => {
  it("keeps the base env and tolerates an absent one", () => {
    withProcessEnvironmentMetadata({}, () => {
      expect(
        withT3ThreadIdentityEnv({ EXISTING_ENV: "kept" }, { threadId: ThreadId.make("thread-1") }),
      ).toEqual({ EXISTING_ENV: "kept", T3_THREAD_ID: "thread-1" });
      expect(withT3ThreadIdentityEnv(undefined, { threadId: ThreadId.make("thread-1") })).toEqual({
        T3_THREAD_ID: "thread-1",
      });
    });
  });

  it("overrides a stale thread id inherited from the base env", () => {
    withProcessEnvironmentMetadata({}, () => {
      expect(
        withT3ThreadIdentityEnv(
          { T3_THREAD_ID: "thread-stale" },
          { threadId: ThreadId.make("thread-1") },
        ).T3_THREAD_ID,
      ).toBe("thread-1");
    });
  });
});
