import { describe, expect, it } from "vite-plus/test";

import {
  createHeadlessPackageJson,
  resolveHeadlessArtifactName,
  resolveHeadlessRuntimeDependencies,
} from "./build-headless-artifact.ts";
import { collectClientAssetReferences } from "./lib/client-assets.ts";

describe("build-headless-artifact", () => {
  it("names linux-x64 artifacts with version and platform", () => {
    expect(resolveHeadlessArtifactName("0.0.23-nightly.20260506.217-fork.1", "linux", "x64")).toBe(
      "t3-headless-0.0.23-nightly.20260506.217-fork.1-linux-x64.tar.gz",
    );
  });

  it("resolves server runtime dependencies without catalog placeholders", () => {
    const dependencies = resolveHeadlessRuntimeDependencies();

    expect(dependencies.effect).not.toBe("catalog:");
    expect(dependencies["@effect/platform-node"]).not.toBe("catalog:");
    expect(dependencies["node-pty"]).toBeDefined();
    expect(dependencies["@anthropic-ai/claude-agent-sdk"]).toBeDefined();
    expect(dependencies["@opencode-ai/sdk"]).toBeDefined();
  });

  it("creates a production package that documents the Node runtime requirement", () => {
    const packageJson = createHeadlessPackageJson("0.0.23-test.1");

    expect(packageJson.version).toBe("0.0.23-test.1");
    expect(packageJson.engines.node).toContain("^22.16");
    expect(packageJson.packageManager).toBe("pnpm@10.24.0");
    expect(packageJson.dependencies["node-pty"]).toBeDefined();
  });
});

describe("client asset validation helpers", () => {
  it("collects local script and stylesheet references only", () => {
    const refs = collectClientAssetReferences(`
      <link href="/assets/index.css?hash=1" rel="stylesheet">
      <script src="/assets/index.js"></script>
      <img src="data:image/png;base64,abc">
      <a href="https://example.com">external</a>
    `);

    expect(refs).toEqual(["/assets/index.css?hash=1", "/assets/index.js"]);
  });
});
