#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const requiredFiles = [
  "AGENTS.md",
  "LLM_INSTRUCTIONS.md",
  ".agents/skills/fork-patch-stack/SKILL.md",
  "docs/README.md",
  "docs/operations/fork-maintenance.md",
  "docs/operations/fork-inventory.toml",
] as const;

const historicalDocuments = new Set([
  "docs/superpowers/specs/2026-07-24-fork-maintenance-design.md",
  "docs/superpowers/plans/2026-07-24-fork-maintenance-phase-0-2.md",
]);

const stalePatterns = [
  /fork-topics\.json/i,
  /compact-stack/i,
  /(?:git\s+)?rebase\s+--autosquash/i,
  /fixup!/i,
  /\b11[- ](?:patch|patches|topic|topics)\b/i,
] as const;

const read = (root: string, path: string): string =>
  NodeFS.readFileSync(NodePath.join(root, path), "utf8");

const walkFiles = (root: string, relative: string): string[] => {
  const start = NodePath.join(root, relative);
  if (!NodeFS.existsSync(start)) return [];
  const files: string[] = [];
  const visit = (absolute: string): void => {
    for (const entry of NodeFS.readdirSync(absolute, { withFileTypes: true })) {
      const child = NodePath.join(absolute, entry.name);
      if (entry.isDirectory()) visit(child);
      else files.push(NodePath.relative(root, child));
    }
  };
  visit(start);
  return files;
};

const localLinkTargets = (contents: string): string[] => {
  const targets: string[] = [];
  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const captured = match[1];
    if (captured === undefined) continue;
    let target = captured.trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    else target = target.split(/\s+/, 1)[0] ?? "";
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const localTarget = target.split("#", 1)[0];
    if (localTarget) targets.push(localTarget);
  }
  return targets;
};

const resolvedLinks = (root: string, source: string): string[] =>
  localLinkTargets(read(root, source)).map((target) => {
    const absolute = target.startsWith("/")
      ? NodePath.resolve(root, `.${target}`)
      : NodePath.resolve(root, NodePath.dirname(source), target);
    return NodePath.normalize(NodePath.relative(root, absolute));
  });

export const checkForkDocs = (root = process.cwd()): string[] => {
  const absoluteRoot = NodePath.resolve(root);
  const errors: string[] = [];

  for (const file of requiredFiles) {
    if (!NodeFS.existsSync(NodePath.join(absoluteRoot, file)))
      errors.push(`missing required fork document: ${file}`);
  }
  if (errors.length > 0) return errors;

  const agentsLinks = resolvedLinks(absoluteRoot, "AGENTS.md");
  if (!agentsLinks.includes("LLM_INSTRUCTIONS.md")) {
    errors.push("AGENTS.md must link to LLM_INSTRUCTIONS.md");
  }

  const llmLinks = resolvedLinks(absoluteRoot, "LLM_INSTRUCTIONS.md");
  for (const target of [
    ".agents/skills/fork-patch-stack/SKILL.md",
    "docs/operations/fork-maintenance.md",
    "docs/operations/fork-inventory.toml",
  ]) {
    if (!llmLinks.includes(target)) errors.push(`LLM_INSTRUCTIONS.md must link to ${target}`);
  }

  const docsReadme = read(absoluteRoot, "docs/README.md");
  for (const route of [
    "Rebase the fork or resolve a patch conflict",
    "Add or change a fork feature",
    "Publish the StGit stack safely",
  ]) {
    if (!docsReadme.includes(route))
      errors.push(`docs/README.md must link the task route: ${route}`);
  }

  const skill = read(absoluteRoot, ".agents/skills/fork-patch-stack/SKILL.md");
  if (!/rebase workflow/i.test(skill) || !/stg rebase/.test(skill)) {
    errors.push("fork-patch-stack skill must contain the rebase workflow");
  }
  if (!/new-concern workflow/i.test(skill) || !/stg new/.test(skill)) {
    errors.push("fork-patch-stack skill must contain the new-concern workflow");
  }

  const markdownFiles = [
    ...requiredFiles.filter((file) => file.endsWith(".md")),
    "docs/operations/ci.md",
    "docs/operations/release.md",
  ].filter((file) => NodeFS.existsSync(NodePath.join(absoluteRoot, file)));
  for (const source of markdownFiles) {
    for (const target of localLinkTargets(read(absoluteRoot, source))) {
      const absolute = target.startsWith("/")
        ? NodePath.resolve(absoluteRoot, `.${target}`)
        : NodePath.resolve(absoluteRoot, NodePath.dirname(source), target);
      const relative = NodePath.relative(absoluteRoot, absolute);
      if (relative === ".." || relative.startsWith(`..${NodePath.sep}`)) {
        errors.push(`${source}: local link escapes the repository: ${target}`);
        continue;
      }
      if (!NodeFS.existsSync(absolute)) {
        errors.push(`${source}: missing local link target: ${target}`);
        continue;
      }
      const realTarget = NodeFS.realpathSync(absolute);
      const realRelative = NodePath.relative(NodeFS.realpathSync(absoluteRoot), realTarget);
      if (realRelative === ".." || realRelative.startsWith(`..${NodePath.sep}`)) {
        errors.push(`${source}: local link resolves outside the repository: ${target}`);
      }
    }
  }

  const activeFiles = new Set([
    ...markdownFiles,
    ...walkFiles(absoluteRoot, ".github/workflows").filter((file) => /\.ya?ml$/.test(file)),
    ...walkFiles(absoluteRoot, "scripts/ci").filter(
      (file) => !file.endsWith(".test.ts") && file !== "scripts/ci/check-fork-docs.ts",
    ),
  ]);
  for (const file of activeFiles) {
    if (historicalDocuments.has(file)) continue;
    const contents = read(absoluteRoot, file);
    for (const pattern of stalePatterns) {
      if (pattern.test(contents))
        errors.push(`${file}: stale pre-StGit terminology matches ${pattern.source}`);
    }
  }

  return errors;
};

if (import.meta.main) {
  const errors = checkForkDocs();
  if (errors.length > 0) {
    for (const error of errors) console.error(`fork docs: ${error}`);
    process.exit(1);
  }
  console.log("Fork documentation check PASS.");
}
