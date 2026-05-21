import { createHmac } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import {
  buildResolverDockerArgs,
  candidateBranchFor,
  normalizeRepositoryDispatch,
  verifyGitHubWebhookSignature,
  type MobileConflictPayload,
} from "./mobile-conflict-controller.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";
const upstreamSha = "fedcba9876543210fedcba9876543210fedcba98";

const payload: MobileConflictPayload = {
  repository: "jimprince/t3code",
  upstream_sha: upstreamSha,
  mobile_sha: sha,
  sync_run_id: "25770000000",
  sync_run_attempt: "1",
  upstream_branch: "t3code/mobile-remote-connect",
  mobile_branch: "feature/mobile-track",
  conflicted_files: ["apps/mobile/src/App.tsx", "packages/client-runtime/src/state.ts"],
  workflow: "Mobile Track Sync",
  run_url: "https://github.com/jimprince/t3code/actions/runs/25770000000",
};

describe("mobile-conflict-controller", () => {
  it("verifies GitHub webhook HMAC signatures", () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const secret = "test-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    assert.isTrue(verifyGitHubWebhookSignature(body, signature, secret));
    assert.isFalse(verifyGitHubWebhookSignature(body, signature, "wrong-secret"));
    assert.isFalse(verifyGitHubWebhookSignature(body, undefined, secret));
  });

  it("normalizes allowed repository_dispatch conflict payloads", () => {
    const normalized = normalizeRepositoryDispatch(
      {
        action: "mobile-track-conflict",
        repository: { full_name: "jimprince/t3code" },
        client_payload: payload,
      },
      new Set(["jimprince/t3code"]),
    );

    assert.deepStrictEqual(normalized, payload);
  });

  it("rejects repository_dispatch payloads from other repositories", () => {
    assert.throws(() =>
      normalizeRepositoryDispatch(
        {
          action: "mobile-track-conflict",
          repository: { full_name: "evil/repo" },
          client_payload: { ...payload, repository: "evil/repo" },
        },
        new Set(["jimprince/t3code"]),
      ),
    );
  });

  it("builds a locked-down Docker invocation without trusted host mounts", () => {
    const args = buildResolverDockerArgs(payload, {
      image: "resolver:latest",
      workspace: "/var/lib/t3code-mobile-conflicts/jobs/25770000000",
      githubToken: "short-lived-token",
    });
    const joined = args.join(" ");

    assert.strictEqual(candidateBranchFor(payload), "automation/mobile-track-conflict/25770000000");
    assert.include(joined, "--user 10001:10001");
    assert.include(joined, "--cap-drop ALL");
    assert.include(joined, "--security-opt no-new-privileges");
    assert.include(joined, "--read-only");
    assert.include(
      joined,
      "type=bind,src=/var/lib/t3code-mobile-conflicts/jobs/25770000000,dst=/workspace",
    );
    assert.notInclude(joined, "/home/brad");
    assert.notInclude(joined, ".ssh");
    assert.notInclude(joined, ".config");
    assert.notInclude(joined, "docker.sock");
    assert.notInclude(joined, "EXPO_TOKEN");
  });
});
