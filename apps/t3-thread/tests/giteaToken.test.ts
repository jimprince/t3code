import * as NodeStream from "node:stream";
import { Command } from "commander";
import { describe, expect, it } from "vite-plus/test";
import {
  registerGiteaTokenCommand,
  readGiteaTokenStdin,
  GiteaTokenCliError,
} from "../src/giteaToken.js";

const sentinel = "synthetic-stdin-only-token";
const argv = [
  "source-control",
  "gitea",
  "set-token",
  "--env",
  "fake",
  "--instance",
  "home",
  "--token-stdin",
  "--root-thread",
  "root",
  "--repository",
  "brad/repo",
  "--issue",
  "74",
];
function harness(fail?: string) {
  const calls: string[] = [];
  const receipts: unknown[] = [];
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerGiteaTokenCommand(program, {
    stdin: NodeStream.Readable.from([sentinel + "\n"]),
    environment: {},
    print: (value) => receipts.push(value),
    client: async () => ({
      withGiteaTokenRpc: async (run) =>
        run({
          request: async <T>(method: string): Promise<T> => {
            calls.push(method);
            if (method === fail) throw new Error(sentinel);
            return (
              {
                serverGetSettings: {
                  giteaInstances: [{ id: "home", webOrigin: "http://git.fake:3000" }],
                },
                giteaSetToken: { instanceId: "home", tokenSet: true, storedMatchesInput: true },
                serverDiscoverSourceControl: {
                  sourceControlProviders: [{ kind: "gitea", auth: { status: "authenticated" } }],
                },
                projectIssuesGet: { issue: { number: 74 } },
              } as Record<string, unknown>
            )[method] as T;
          },
        }),
    }),
  });
  return { calls, receipts, run: () => program.parseAsync(argv, { from: "user" }) };
}
describe("stdin-only Gitea consumer", () => {
  it("prints only the receipt after both verification reads", async () => {
    const h = harness();
    await h.run();
    expect(h.calls).toEqual([
      "serverGetSettings",
      "giteaSetToken",
      "serverDiscoverSourceControl",
      "projectIssuesGet",
    ]);
    expect(h.receipts).toEqual([{ instanceId: "home", tokenSet: true, storedMatchesInput: true }]);
  });
  it.each(["giteaSetToken", "serverDiscoverSourceControl", "projectIssuesGet"])(
    "does not retry or expose a failure at %s",
    async (method) => {
      const h = harness(method);
      await expect(h.run()).rejects.toMatchObject({
        exitCode: method === "giteaSetToken" ? 30 : 40,
      });
      expect(h.calls.filter((call) => call === "giteaSetToken")).toHaveLength(1);
      expect(h.receipts).toEqual([]);
      try {
        await harness(method).run();
      } catch (error) {
        expect(String(error)).not.toContain(sentinel);
        expect(JSON.stringify(error)).not.toContain(sentinel);
      }
    },
  );
  it.each([
    "",
    "\n",
    "redacted",
    "••••••",
    sentinel + "\n\n",
    " token",
    "token ",
    "é",
    "a".repeat(4097),
  ])("rejects invalid input without dispatch", async (value) => {
    await expect(readGiteaTokenStdin(NodeStream.Readable.from([value]), {})).rejects.toBeInstanceOf(
      GiteaTokenCliError,
    );
  });
  it("strips only one trailing newline and requires EOF", async () => {
    expect(await readGiteaTokenStdin(NodeStream.Readable.from([sentinel + "\r\n"]), {})).toBe(
      sentinel,
    );
    const stream = new NodeStream.PassThrough();
    const pending = readGiteaTokenStdin(stream, {}, 10);
    stream.write(sentinel);
    await expect(pending).rejects.toMatchObject({ exitCode: 2 });
    stream.destroy();
  });
  it("rejects TTY and credential environment keys without inspecting their values", async () => {
    const tty = Object.assign(new NodeStream.PassThrough(), { isTTY: true });
    await expect(readGiteaTokenStdin(tty, {})).rejects.toMatchObject({ exitCode: 2 });
    const env = Object.defineProperty({}, "GITEA_TOKEN", {
      enumerable: true,
      get: () => {
        throw new Error("must not inspect value");
      },
    });
    await expect(
      readGiteaTokenStdin(NodeStream.Readable.from([sentinel]), env),
    ).rejects.toMatchObject({
      exitCode: 2,
    });
    tty.destroy();
  });
});

it("redacts argv/parser failures in the actual CLI process", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  for (const tail of [["--token", sentinel], [sentinel]]) {
    const child = spawnSync(tsx, [cli, ...argv, ...tail], {
      encoding: "utf8",
      timeout: 10_000,
      input: sentinel,
    });
    expect(child.status).toBe(2);
    expect(child.stderr).toBe("Gitea token input rejected.\n");
    expect(child.stdout + child.stderr).not.toContain(sentinel);
  }
}, 30_000);
