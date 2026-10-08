// @effect-diagnostics globalTimers:off
// Promise-based CLI transport; server services remain Effect-based.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node stdin type at the Promise-based CLI boundary.
import type * as NodeStream from "node:stream";
import {
  GITEA_TOKEN_REDACTED,
  GiteaTokenSetInput,
  type GiteaTokenSetResult,
  type ServerSettings,
  type SourceControlDiscoveryResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeTokenInput = Schema.decodeUnknownSync(GiteaTokenSetInput);

export interface GiteaTokenRpc {
  request<T>(
    method:
      | "serverGetSettings"
      | "giteaSetToken"
      | "serverDiscoverSourceControl"
      | "projectIssuesGet",
    input: unknown,
  ): Promise<T>;
}
export interface TokenClient {
  withGiteaTokenRpc<T>(run: (rpc: GiteaTokenRpc) => Promise<T>): Promise<T>;
}
export type TokenOptions = {
  env: string;
  instance: string;
  tokenStdin: boolean;
  rootThread: string;
  repository: string;
  issue: string;
};
export class GiteaTokenCliError extends Error {
  readonly exitCode: 2 | 20 | 30 | 40;
  constructor(exitCode: 2 | 20 | 30 | 40) {
    super(
      {
        2: "Gitea token input rejected.",
        20: "Gitea token preflight failed; no update was requested.",
        30: "Gitea token update outcome is uncertain; do not retry automatically.",
        40: "Gitea token was stored, but verification failed; do not revoke the previous token.",
      }[exitCode],
    );
    this.name = "GiteaTokenCliError";
    this.exitCode = exitCode;
  }
}

/** EOF is required before dispatch; a timeout or overflow never submits partial input. */
export async function readGiteaTokenStdin(
  stdin: NodeStream.Readable & { isTTY?: boolean },
  environment: NodeJS.ProcessEnv,
  deadlineMs = 15_000,
): Promise<string> {
  if (
    stdin.isTTY ||
    Object.keys(environment).some((name) =>
      /^(?:T3_)?GITEA_.*(?:TOKEN|PASSWORD|SECRET|PAT)$/i.test(name),
    )
  ) {
    throw new GiteaTokenCliError(2);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      stdin.removeListener("data", data);
      stdin.removeListener("end", end);
      stdin.removeListener("error", fail);
      stdin.pause();
      for (const chunk of chunks) chunk.fill(0);
    };
    const fail = () => {
      cleanup();
      reject(new GiteaTokenCliError(2));
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      // The bound includes the optional terminating newline.
      if (size > 4096) {
        bytes.fill(0);
        fail();
        return;
      }
      chunks.push(bytes);
    };
    const end = () => {
      const bytes = Buffer.concat(chunks);
      const token = bytes.toString("ascii").replace(/\r?\n$/, "");
      const valid =
        bytes.every((byte) => byte < 128) &&
        /^[\x21-\x7e]+$/.test(token) &&
        token !== GITEA_TOKEN_REDACTED &&
        !/^redacted$/i.test(token);
      bytes.fill(0);
      cleanup();
      if (!valid) reject(new GiteaTokenCliError(2));
      else resolve(token);
    };
    const timer = setTimeout(fail, deadlineMs);
    stdin.on("data", data).once("end", end).once("error", fail);
    stdin.resume();
  });
}

export type TokenDependencies = {
  client: (environment: string) => Promise<TokenClient>;
  stdin?: NodeStream.Readable & { isTTY?: boolean };
  environment?: NodeJS.ProcessEnv;
  print?: (receipt: GiteaTokenSetResult) => void;
  requestTimeoutMs?: number;
};

export async function installGiteaToken(options: TokenOptions, dependencies: TokenDependencies) {
  if (
    !options.tokenStdin ||
    !/^[1-9]\d*$/.test(options.issue) ||
    !Number.isSafeInteger(Number(options.issue)) ||
    !/^[^/\s]+\/[^/\s]+$/.test(options.repository)
  )
    throw new GiteaTokenCliError(2);
  const token = await readGiteaTokenStdin(
    dependencies.stdin ?? process.stdin,
    dependencies.environment ?? process.env,
  );
  let stage: 20 | 30 | 40 = 20;
  try {
    const client = await dependencies.client(options.env);
    await client.withGiteaTokenRpc(async (rpc) => {
      // Bound the entire connection. Disposal interrupts a stuck request; never retry it.
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const settings = await rpc.request<ServerSettings>("serverGetSettings", {});
            const instance = settings.giteaInstances.find(
              (candidate) => candidate.id === options.instance,
            );
            if (!instance) throw new GiteaTokenCliError(20);
            const host = new URL(instance.webOrigin).host;
            const input = decodeTokenInput({
              instanceId: options.instance,
              token,
            });
            if (!active) throw new GiteaTokenCliError(20);
            stage = 30;
            const receipt = await rpc.request<GiteaTokenSetResult>("giteaSetToken", input);
            stage = 40;
            if (
              receipt.instanceId !== options.instance ||
              !receipt.tokenSet ||
              !receipt.storedMatchesInput
            )
              throw new GiteaTokenCliError(40);
            // Discovery deliberately probes /user again for every configured instance.
            const discovery = await rpc.request<SourceControlDiscoveryResult>(
              "serverDiscoverSourceControl",
              {},
            );
            if (
              !discovery.sourceControlProviders.some(
                (provider) => provider.kind === "gitea" && provider.auth.status === "authenticated",
              )
            )
              throw new GiteaTokenCliError(40);
            await rpc.request("projectIssuesGet", {
              rootThreadId: options.rootThread,
              host,
              repository: options.repository,
              number: Number(options.issue),
            });
            if (!active) throw new GiteaTokenCliError(40);
            (dependencies.print ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`)))(
              {
                instanceId: receipt.instanceId,
                tokenSet: receipt.tokenSet,
                storedMatchesInput: receipt.storedMatchesInput,
              },
            );
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new GiteaTokenCliError(stage)),
              dependencies.requestTimeoutMs ?? 30_000,
            );
          }),
        ]);
      } finally {
        active = false;
        clearTimeout(timer);
      }
    });
  } catch (error) {
    throw error instanceof GiteaTokenCliError ? error : new GiteaTokenCliError(stage);
  }
}
