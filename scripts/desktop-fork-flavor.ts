export function resolveDesktopFlavorMetadata(flavor: "stable" | "dev"): {
  readonly productName: string;
  readonly appId: string;
  readonly artifactName: string;
  readonly executableName: string;
  readonly linuxDesktopEntryName: string;
  readonly packageName: string;
} {
  if (flavor === "dev") {
    return {
      productName: "T3 Code (Fork Dev)",
      appId: "com.t3tools.t3code.fork.dev",
      artifactName: "T3-Code-Fork-Dev-${version}-${arch}.${ext}",
      executableName: "t3code-fork-dev",
      linuxDesktopEntryName: "t3code-fork-dev",
      packageName: "t3code-fork-dev",
    };
  }

  return {
    productName: "T3 Code (Fork)",
    appId: "com.t3tools.t3code.fork",
    artifactName: "T3-Code-Fork-${version}-${arch}.${ext}",
    executableName: "t3code-fork",
    linuxDesktopEntryName: "t3code-fork",
    packageName: "t3code-fork",
  };
}
