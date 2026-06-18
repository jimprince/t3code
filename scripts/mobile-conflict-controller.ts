#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface MobileConflictPayload {
  readonly repository: string;
  readonly upstream_sha: string;
  readonly mobile_sha: string;
  readonly sync_run_id: string;
  readonly sync_run_attempt: string;
  readonly upstream_branch: string;
  readonly mobile_branch: string;
  readonly conflicted_files: ReadonlyArray<string>;
  readonly workflow?: string;
  readonly run_url?: string;
}

export interface RepositoryDispatchWebhook {
  readonly action?: string;
  readonly repository?: {
    readonly full_name?: string;
  };
  readonly client_payload?: unknown;
}

export interface ControllerConfig {
  readonly port: number;
  readonly webhookSecret: string;
  readonly allowedRepositories: ReadonlySet<string>;
  readonly eventType: string;
  readonly workspaceRoot: string;
  readonly resolverImage: string;
  readonly resolverGithubToken: string;
}

export const verifyGitHubWebhookSignature = (
  body: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean => {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const received = signatureHeader.trim();
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
};

const isSha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
const isBranch = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._/-]+$/u.test(value) && !value.includes("..");
const isRunId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._-]+$/u.test(value);

export const normalizeRepositoryDispatch = (
  webhook: RepositoryDispatchWebhook,
  allowedRepositories: ReadonlySet<string>,
  eventType = "mobile-track-conflict",
): MobileConflictPayload => {
  if (webhook.action !== eventType) {
    throw new Error(`Unsupported repository_dispatch action: ${webhook.action ?? "<missing>"}`);
  }

  const repository = webhook.repository?.full_name;
  if (!repository || !allowedRepositories.has(repository)) {
    throw new Error(`Repository is not allowed: ${repository ?? "<missing>"}`);
  }

  const payload = webhook.client_payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("repository_dispatch client_payload must be an object.");
  }

  const record = payload as Record<string, unknown>;
  if (record.repository !== repository) {
    throw new Error("client_payload.repository must match webhook repository.full_name.");
  }
  if (!isSha(record.upstream_sha))
    throw new Error("client_payload.upstream_sha must be a full SHA.");
  if (!isSha(record.mobile_sha)) throw new Error("client_payload.mobile_sha must be a full SHA.");
  if (!isRunId(record.sync_run_id)) throw new Error("client_payload.sync_run_id is invalid.");
  if (!isRunId(record.sync_run_attempt))
    throw new Error("client_payload.sync_run_attempt is invalid.");
  if (!isBranch(record.upstream_branch))
    throw new Error("client_payload.upstream_branch is invalid.");
  if (!isBranch(record.mobile_branch)) throw new Error("client_payload.mobile_branch is invalid.");
  if (
    !Array.isArray(record.conflicted_files) ||
    !record.conflicted_files.every((file) => typeof file === "string")
  ) {
    throw new Error("client_payload.conflicted_files must be a string array.");
  }

  return {
    repository,
    upstream_sha: record.upstream_sha,
    mobile_sha: record.mobile_sha,
    sync_run_id: record.sync_run_id,
    sync_run_attempt: record.sync_run_attempt,
    upstream_branch: record.upstream_branch,
    mobile_branch: record.mobile_branch,
    conflicted_files: record.conflicted_files,
    ...(typeof record.workflow === "string" ? { workflow: record.workflow } : {}),
    ...(typeof record.run_url === "string" ? { run_url: record.run_url } : {}),
  };
};

export const candidateBranchFor = (payload: Pick<MobileConflictPayload, "sync_run_id">): string =>
  `automation/mobile-track-conflict/${payload.sync_run_id}`;

export const buildResolverDockerArgs = (
  payload: MobileConflictPayload,
  input: {
    readonly image: string;
    readonly workspace: string;
    readonly githubToken: string;
  },
): ReadonlyArray<string> => [
  "run",
  "--rm",
  "--network",
  "bridge",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,size=512m",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "256",
  "--memory",
  "4g",
  "--cpus",
  "2",
  "--user",
  "10001:10001",
  "--workdir",
  "/workspace",
  "--mount",
  `type=bind,src=${input.workspace},dst=/workspace,readonly=false`,
  "--env",
  `GITHUB_TOKEN=${input.githubToken}`,
  "--env",
  `REPOSITORY=${payload.repository}`,
  "--env",
  `UPSTREAM_SHA=${payload.upstream_sha}`,
  "--env",
  `MOBILE_SHA=${payload.mobile_sha}`,
  "--env",
  `SYNC_RUN_ID=${payload.sync_run_id}`,
  "--env",
  `SYNC_RUN_ATTEMPT=${payload.sync_run_attempt}`,
  "--env",
  `UPSTREAM_BRANCH=${payload.upstream_branch}`,
  "--env",
  `MOBILE_BRANCH=${payload.mobile_branch}`,
  "--env",
  `CANDIDATE_BRANCH=${candidateBranchFor(payload)}`,
  "--env",
  `CONFLICTED_FILES_JSON=${JSON.stringify(payload.conflicted_files)}`,
  "--env",
  `SYNC_RUN_URL=${payload.run_url ?? ""}`,
  input.image,
];

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const send = (response: ServerResponse, statusCode: number, body: string) => {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
};

const runResolver = async (
  payload: MobileConflictPayload,
  config: ControllerConfig,
): Promise<void> => {
  const workspace = resolve(config.workspaceRoot, payload.sync_run_id);
  await mkdir(workspace, { recursive: true });

  const args = buildResolverDockerArgs(payload, {
    image: config.resolverImage,
    workspace,
    githubToken: config.resolverGithubToken,
  });

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Resolver container exited with code ${code ?? "unknown"}.`));
    });
  });
};

const loadConfig = (): ControllerConfig => ({
  port: Number(process.env.MOBILE_CONFLICT_CONTROLLER_PORT ?? "8787"),
  webhookSecret: process.env.MOBILE_CONFLICT_WEBHOOK_SECRET ?? "",
  allowedRepositories: new Set(
    (process.env.MOBILE_CONFLICT_ALLOWED_REPOS ?? "jimprince/t3code").split(","),
  ),
  eventType: process.env.MOBILE_CONFLICT_EVENT_TYPE ?? "mobile-track-conflict",
  workspaceRoot:
    process.env.MOBILE_CONFLICT_WORKSPACE_ROOT ?? "/var/lib/t3code-mobile-conflicts/jobs",
  resolverImage:
    process.env.MOBILE_CONFLICT_RESOLVER_IMAGE ?? "t3code-mobile-conflict-resolver:latest",
  resolverGithubToken: process.env.MOBILE_CONFLICT_RESOLVER_GITHUB_TOKEN ?? "",
});

export const createMobileConflictController = (config: ControllerConfig) => {
  if (!config.webhookSecret) throw new Error("MOBILE_CONFLICT_WEBHOOK_SECRET is required.");
  if (!config.resolverGithubToken)
    throw new Error("MOBILE_CONFLICT_RESOLVER_GITHUB_TOKEN is required.");

  let queue = Promise.resolve();

  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/github/webhook") {
      send(response, 404, "not found\n");
      return;
    }

    const body = await readBody(request);
    if (
      !verifyGitHubWebhookSignature(
        body,
        request.headers["x-hub-signature-256"] as string | undefined,
        config.webhookSecret,
      )
    ) {
      send(response, 401, "invalid signature\n");
      return;
    }

    if (request.headers["x-github-event"] !== "repository_dispatch") {
      send(response, 202, "ignored event\n");
      return;
    }

    let payload: MobileConflictPayload;
    try {
      payload = normalizeRepositoryDispatch(
        JSON.parse(body.toString("utf8")),
        config.allowedRepositories,
        config.eventType,
      );
    } catch (error) {
      send(response, 400, `${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }

    queue = queue
      .then(() => runResolver(payload, config))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      });

    send(response, 202, `queued ${join(payload.repository, candidateBranchFor(payload))}\n`);
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const server = createMobileConflictController(config);
  server.listen(config.port, () => {
    process.stdout.write(`mobile conflict controller listening on :${config.port}\n`);
  });
}
