/** Fork profile names never fall back to upstream profiles or credentials. */
export function resolveForkDesktopIdentity(flavor: "stable" | "dev", isDevelopment = false) {
  if (isDevelopment) return { current: "t3code-fork-source-dev", legacy: "T3 Code (Fork Source Dev)", fallback: "t3code-fork-source-dev", v1Profiles: ["T3 Code (Fork Source Dev)"] };
  if (flavor === "dev") return { current: "t3code-fork-dev-v2", legacy: "T3 Code (Fork Dev)", fallback: "t3code-fork-dev", v1Profiles: ["T3 Code (Fork Dev)", "t3code-fork-dev"] };
  return { current: "t3code-fork-v2", legacy: "T3 Code (Fork)", fallback: "t3code-fork", v1Profiles: ["T3 Code (Fork)", "t3code-fork"] };
}
