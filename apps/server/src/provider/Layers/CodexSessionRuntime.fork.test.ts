describe("buildCodexChildEnv", () => {
  it("injects T3 thread and environment metadata while preserving the base env", () => {
    const env = buildCodexChildEnv({
      threadId: ThreadId.make("thread-env-test"),
      environmentId: EnvironmentId.make("environment-env-test"),
      environmentName: "local-mbp",
      environment: { EXISTING_ENV: "kept" },
      homePath: "/tmp/codex-home",
    });

    NodeAssert.equal(env.T3_THREAD_ID, "thread-env-test");
    NodeAssert.equal(env.T3_ENVIRONMENT_ID, "environment-env-test");
    NodeAssert.equal(env.T3_ENVIRONMENT_NAME, "local-mbp");
    NodeAssert.equal(env.CODEX_HOME, "/tmp/codex-home");
    NodeAssert.equal(env.EXISTING_ENV, "kept");
  });

  it("injects T3_THREAD_ID without optional environment metadata or CODEX_HOME", () => {
    const previousEnvironmentId = process.env.T3_ENVIRONMENT_ID;
    const previousEnvironmentName = process.env.T3_ENVIRONMENT_NAME;
    delete process.env.T3_ENVIRONMENT_ID;
    delete process.env.T3_ENVIRONMENT_NAME;
    try {
      const env = buildCodexChildEnv({
        threadId: ThreadId.make("thread-env-test"),
        environment: {},
      });

      NodeAssert.equal(env.T3_THREAD_ID, "thread-env-test");
      NodeAssert.equal(env.T3_ENVIRONMENT_ID, undefined);
      NodeAssert.equal(env.T3_ENVIRONMENT_NAME, undefined);
      NodeAssert.equal(env.CODEX_HOME, undefined);
    } finally {
      if (previousEnvironmentId === undefined) {
        delete process.env.T3_ENVIRONMENT_ID;
      } else {
        process.env.T3_ENVIRONMENT_ID = previousEnvironmentId;
      }
      if (previousEnvironmentName === undefined) {
        delete process.env.T3_ENVIRONMENT_NAME;
      } else {
        process.env.T3_ENVIRONMENT_NAME = previousEnvironmentName;
      }
    }
  });

  it("uses process-level T3 environment metadata when no runtime override is supplied", () => {
    const previousEnvironmentId = process.env.T3_ENVIRONMENT_ID;
    const previousEnvironmentName = process.env.T3_ENVIRONMENT_NAME;
    process.env.T3_ENVIRONMENT_ID = "environment-process";
    process.env.T3_ENVIRONMENT_NAME = "process-env";
    try {
      const env = buildCodexChildEnv({
        threadId: ThreadId.make("thread-env-test"),
        environment: {},
      });

      NodeAssert.equal(env.T3_ENVIRONMENT_ID, "environment-process");
      NodeAssert.equal(env.T3_ENVIRONMENT_NAME, "process-env");
    } finally {
      if (previousEnvironmentId === undefined) {
        delete process.env.T3_ENVIRONMENT_ID;
      } else {
        process.env.T3_ENVIRONMENT_ID = previousEnvironmentId;
      }
      if (previousEnvironmentName === undefined) {
        delete process.env.T3_ENVIRONMENT_NAME;
      } else {
        process.env.T3_ENVIRONMENT_NAME = previousEnvironmentName;
      }
    }
  });
