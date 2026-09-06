// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

export type CommandOptions = {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly quiet?: boolean;
};

export const runCommand = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
): string => {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["inherit", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
};

export const parseFlagArguments = (
  args: readonly string[],
  booleanFlags: ReadonlySet<string>,
): ReadonlyMap<string, string | true> => {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument: ${String(flag)}`);
    if (parsed.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    if (booleanFlags.has(flag)) {
      parsed.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    parsed.set(flag, value);
    index += 1;
  }
  return parsed;
};

export const requiredFlag = (flags: ReadonlyMap<string, string | true>, name: string): string => {
  const value = flags.get(name);
  if (typeof value !== "string") throw new Error(`${name} is required`);
  return value;
};
