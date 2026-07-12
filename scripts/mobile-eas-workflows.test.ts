import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const workflowPaths = [
  "mobile-eas-development.yml",
  "mobile-eas-preview.yml",
  "mobile-eas-production.yml",
] as const;

describe("mobile EAS workflows", () => {
  it("installs the action-managed EAS CLI with npm", () => {
    for (const workflowPath of workflowPaths) {
      const workflow = NodeFS.readFileSync(
        new URL(`../.github/workflows/${workflowPath}`, import.meta.url),
        "utf8",
      );

      assert.include(workflow, "uses: expo/expo-github-action@v8");
      assert.include(workflow, "packager: npm");
      assert.notInclude(workflow, "packager: pnpm");
    }
  });
});
