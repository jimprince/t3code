// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { SpawnExecutableResolver } from "@t3tools/shared/shell";

const realpath = (path: string) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
};

/** Internal VCS work must not enter the safety wrappers intended for agent shells. */
export function makeInternalGitResolver(resolveExecutable: SpawnExecutableResolver) {
  const cache = new Map<string, string | undefined>();
  return (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, cwd: string) => {
    // Preserve the runner's existing Windows executable/PATHEXT handling.
    if (platform === "win32") return "git";
    const pathEntries = (env.PATH ?? "").split(":");
    const home = env.HOME ?? NodeOS.homedir();
    const key = JSON.stringify([
      platform,
      home,
      env.PATH,
      pathEntries.some((entry) => !NodePath.isAbsolute(entry)) ? cwd : null,
    ]);
    if (cache.has(key)) return cache.get(key);

    const wrapperDirectory = NodePath.join(home, ".shared", "bin");
    const canonicalWrapperDirectory = realpath(wrapperDirectory);
    const isWrapper = (path: string) => {
      const directory = NodePath.dirname(path);
      return (
        directory === wrapperDirectory ||
        directory === canonicalWrapperDirectory ||
        directory.endsWith("/.shared/bin")
      );
    };
    const candidates = [
      ...(platform === "darwin" ? ["/usr/bin/git"] : []),
      ...pathEntries.map((entry) => NodePath.resolve(cwd, entry, "git")),
    ];
    let executable: string | undefined;
    for (const candidate of new Set(candidates)) {
      if (isWrapper(candidate)) continue;
      const resolved = resolveExecutable(candidate, platform, env);
      if (resolved === undefined) continue;
      const canonical = realpath(resolved);
      // Exclude aliases of the wrapper as well as its literal PATH directory.
      if (isWrapper(canonical)) continue;
      executable = canonical;
      break;
    }
    // Cache absence too: never fall back to bare Git and accidentally launch the wrapper.
    cache.set(key, executable);
    return executable;
  };
}
