import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Source and dependency inputs are hashed in this Node process, never via git or a shell.
export function sourceHash(workspace) {
  const root = NodePath.resolve(workspace, "../..");
  const hash = NodeCrypto.createHash("sha256");
  function visit(path) {
    for (const entry of NodeFS.readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = NodePath.resolve(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else add(file);
    }
  }
  function add(file) {
    hash.update(NodePath.relative(root, file));
    hash.update("\0");
    hash.update(NodeFS.readFileSync(file));
    hash.update("\0");
  }
  visit(NodePath.resolve(workspace, "src"));
  visit(NodePath.resolve(workspace, "scripts"));
  visit(NodePath.resolve(root, "packages/contracts/src"));
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "packages/contracts/package.json",
    "apps/t3-thread/package.json",
  ])
    add(NodePath.resolve(root, file));
  return hash.digest("hex");
}
