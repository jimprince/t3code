#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

declare const Bun: {
  readonly TOML: { readonly parse: (contents: string) => unknown };
};

type InventoryPatch = {
  readonly name?: unknown;
  readonly subject?: unknown;
  readonly class?: unknown;
  readonly purpose?: unknown;
  readonly retire_when?: unknown;
  readonly depends_on?: unknown;
  readonly roles?: unknown;
  readonly note?: unknown;
  readonly question?: unknown;
};

type Inventory = {
  readonly schema?: unknown;
  readonly patch?: unknown;
};

type StackJson = {
  readonly head?: unknown;
  readonly applied?: unknown;
  readonly unapplied?: unknown;
  readonly hidden?: unknown;
  readonly patches?: unknown;
};

type StackContextPatch = {
  readonly name: string;
  readonly subject: string;
  readonly oid: string;
  readonly class: "product" | "divergence" | "upstream-bound";
  readonly purpose: string;
  readonly retireWhen: string;
  readonly dependsOn: readonly string[];
  readonly roles: readonly string[];
  readonly note: string | null;
  readonly questions: readonly Record<string, unknown>[];
};

export type StgitStackContext = {
  readonly contract: "t3code.stgit-stack-context";
  readonly version: 1;
  readonly inventorySchema: 2;
  readonly head: string;
  readonly base: string;
  readonly inventoryPath: string;
  readonly instructionPaths: readonly string[];
  readonly patches: readonly StackContextPatch[];
  readonly roleOwners: Readonly<Record<string, string>>;
};

const cwd = process.cwd();
const gitBin = process.env.SYNC_GIT_BIN ?? "git";
const inventoryPath = process.env.STGIT_INVENTORY ?? "docs/operations/fork-inventory.toml";
const metadataRef = process.env.STGIT_METADATA_REF ?? "refs/stacks/stgit/adopt";
const headRef = process.env.STGIT_HEAD ?? "HEAD";
const instructionPaths = [
  "AGENTS.md",
  "LLM_INSTRUCTIONS.md",
  ".agents/skills/fork-patch-stack/SKILL.md",
  "docs/operations/fork-maintenance.md",
  "docs/operations/fork-inventory.toml",
] as const;

const git = (...args: readonly string[]): string => {
  const result = NodeChildProcess.spawnSync(gitBin, [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${gitBin} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};

const parseInventory = (contents: string, source: string, errors: string[]): InventoryPatch[] => {
  let parsed: Inventory;
  try {
    parsed = Bun.TOML.parse(contents) as Inventory;
  } catch (error) {
    errors.push(`${source}: invalid TOML: ${String(error)}`);
    return [];
  }
  if (parsed.schema !== 2) errors.push(`${source}: schema must be 2`);
  if (!Array.isArray(parsed.patch)) {
    errors.push(`${source}: patch must be an array`);
    return [];
  }
  return parsed.patch as InventoryPatch[];
};

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

const loadStack = (): StackJson =>
  JSON.parse(git("show", `${metadataRef}:stack.json`)) as StackJson;

const questions = (
  value: unknown,
  patchName: string,
  errors: string[],
): readonly Record<string, unknown>[] => {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (
    entries.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))
  ) {
    errors.push(`${patchName}: question must be a table or array of tables`);
    return [];
  }
  return entries as readonly Record<string, unknown>[];
};

export const inspectStgitStack = (): {
  readonly errors: string[];
  readonly context?: StgitStackContext;
} => {
  const errors: string[] = [];
  let stack: StackJson;
  try {
    stack = loadStack();
  } catch (error) {
    return { errors: [`unable to read ${metadataRef}: ${String(error)}`] };
  }

  const head = git("rev-parse", headRef);
  if (stack.head !== head)
    errors.push(`stack.json.head ${String(stack.head)} does not equal ${headRef} ${head}`);
  const applied = strings(stack.applied);
  const unapplied = strings(stack.unapplied);
  const hidden = strings(stack.hidden);
  if (!applied) errors.push("stack.json.applied must be a string array");
  if (!unapplied || unapplied.length > 0) errors.push("all StGit patches must be applied");
  if (!hidden || hidden.length > 0)
    errors.push("hidden StGit patches are not allowed for publication");
  if (!applied) return { errors };

  let base = "";

  const patchMap = stack.patches as Record<string, { readonly oid?: unknown }> | undefined;
  if (!patchMap || typeof patchMap !== "object")
    return { errors: [...errors, "stack.json.patches must be an object"] };
  const oids: string[] = [];
  for (const name of applied) {
    const oid = patchMap[name]?.oid;
    if (typeof oid !== "string") errors.push(`stack.json is missing oid for applied patch ${name}`);
    else oids.push(oid);
  }
  if (oids.length !== applied.length) return { errors };

  if (oids.at(-1) !== head)
    errors.push(`top applied patch ${oids.at(-1)} does not equal ${headRef} ${head}`);
  for (let index = 1; index < oids.length; index += 1) {
    const parent = git("rev-parse", `${oids[index]}^`);
    if (parent !== oids[index - 1])
      errors.push(`${applied[index]} is not directly based on ${applied[index - 1]}`);
  }
  if (oids.length > 0) {
    const renderedBase = git("rev-parse", `${oids[0]}^`);
    base = renderedBase;
    const rendered = git("rev-list", "--reverse", `${oids[0]}^..${head}`)
      .split("\n")
      .filter(Boolean);
    if (JSON.stringify(rendered) !== JSON.stringify(oids)) {
      errors.push("rendered commits contain missing, extra, or reordered patches");
    }
    if (process.env.STGIT_BASE) {
      const base = git("rev-parse", process.env.STGIT_BASE);
      if (git("rev-parse", `${oids[0]}^`) !== base)
        errors.push(`oldest patch is not based on STGIT_BASE ${base}`);
    }
  }

  const inventory = parseInventory(
    NodeFS.readFileSync(inventoryPath, "utf8"),
    inventoryPath,
    errors,
  );
  const inventoryNames = inventory.map((entry) => entry.name);
  if (JSON.stringify(inventoryNames) !== JSON.stringify(applied)) {
    errors.push("final inventory order must exactly match stack.json.applied");
  }

  const classes = new Set(["product", "divergence", "upstream-bound"]);
  const seenNames = new Set<string>();
  const roleOwners = new Map<string, string>();
  const contextPatches: StackContextPatch[] = [];
  for (let index = 0; index < inventory.length; index += 1) {
    const entry = inventory[index];
    const expectedName = applied[index];
    if (entry === undefined) {
      errors.push(`inventory patch ${index + 1}: entry is missing`);
      continue;
    }
    const expectedOid = oids[index];
    const expectedSubject = expectedOid ? git("show", "-s", "--format=%s", expectedOid) : undefined;
    if (typeof entry.name !== "string" || entry.name.length === 0)
      errors.push(`inventory patch ${index + 1}: name is required`);
    if (entry.name !== expectedName)
      errors.push(`inventory patch ${index + 1}: name must be ${expectedName}`);
    if (entry.subject !== expectedSubject)
      errors.push(
        `${expectedName}: inventory subject must equal ${JSON.stringify(expectedSubject)}`,
      );
    if (typeof entry.subject === "string") {
      const legacyRepairPrefix = ["fix", "up!"].join("");
      if (
        entry.subject.toLowerCase().startsWith(legacyRepairPrefix) ||
        /^(?:squash!|wip\b|chore\(release\): prepare\b)/i.test(entry.subject)
      ) {
        errors.push(`${expectedName}: forbidden stack subject ${entry.subject}`);
      }
    }
    if (typeof entry.class !== "string" || !classes.has(entry.class))
      errors.push(`${expectedName}: invalid class`);
    if (typeof entry.purpose !== "string" || entry.purpose.trim().length === 0)
      errors.push(`${expectedName}: purpose is required`);
    if (typeof entry.retire_when !== "string" || entry.retire_when.trim().length === 0) {
      errors.push(`${expectedName}: retire_when is required`);
    }
    const dependencies = strings(entry.depends_on);
    if (!dependencies) errors.push(`${expectedName}: depends_on must be a string array`);
    else {
      for (const dependency of dependencies) {
        if (!seenNames.has(dependency))
          errors.push(`${expectedName}: dependency ${dependency} must name an earlier patch`);
      }
    }
    const roles = strings(entry.roles);
    if (!roles) errors.push(`${expectedName}: roles must be a string array`);
    else {
      for (const role of roles) {
        if (role.length === 0) errors.push(`${expectedName}: roles may not be empty`);
        const owner = roleOwners.get(role);
        if (owner) errors.push(`${role} is owned by both ${owner} and ${expectedName}`);
        else
          roleOwners.set(role, typeof entry.name === "string" ? entry.name : `patch-${index + 1}`);
      }
    }
    if (entry.note !== undefined && typeof entry.note !== "string")
      errors.push(`${expectedName}: note must be a string when present`);
    const patchQuestions = questions(entry.question, String(expectedName), errors);
    if (
      typeof entry.name === "string" &&
      typeof entry.subject === "string" &&
      typeof entry.class === "string" &&
      classes.has(entry.class) &&
      typeof entry.purpose === "string" &&
      typeof entry.retire_when === "string" &&
      dependencies &&
      roles &&
      expectedOid
    ) {
      contextPatches.push({
        name: entry.name,
        subject: entry.subject,
        oid: expectedOid,
        class: entry.class as StackContextPatch["class"],
        purpose: entry.purpose,
        retireWhen: entry.retire_when,
        dependsOn: dependencies,
        roles,
        note: typeof entry.note === "string" ? entry.note : null,
        questions: patchQuestions,
      });
    }
    if (typeof entry.name === "string") seenNames.add(entry.name);
  }
  for (const role of ["lockfile-owner", "release-workflow-owner", "agent-docs-owner"]) {
    if (!roleOwners.has(role)) errors.push(`inventory requires exactly one ${role}`);
  }

  for (let index = 0; index < applied.length; index += 1) {
    const name = applied[index];
    const oid = oids[index];
    if (name === undefined || oid === undefined) {
      errors.push(`stack entry ${index + 1} is incomplete`);
      continue;
    }
    let atPatch: InventoryPatch[] = [];
    try {
      atPatch = parseInventory(
        git("show", `${oid}:${inventoryPath}`),
        `${name}:${inventoryPath}`,
        errors,
      );
    } catch {
      errors.push(`${name} must contain ${inventoryPath} and add its own stanza`);
      continue;
    }
    const expectedPrefix = applied.slice(0, index + 1);
    const atPatchNames = atPatch.map((entry) => entry.name);
    if (JSON.stringify(atPatchNames) !== JSON.stringify(expectedPrefix)) {
      const foundAt = atPatchNames.indexOf(name);
      const positionHint =
        foundAt === -1
          ? `its stanza is missing at that patch`
          : `its stanza sits at position ${foundAt + 1} of ${atPatchNames.length}, expected position ${index + 1}`;
      errors.push(
        `${name} must add exactly its own ordered inventory stanza: ` +
          `${positionHint}. Stanza order must match stack.json.applied — ` +
          `a new top-of-stack patch's [[patch]] block goes LAST in ${inventoryPath}`,
      );
    }
  }

  const desiredRefs = applied.map((name) => `refs/patches/stgit/adopt/${name}`);
  const localRefs = git("for-each-ref", "--format=%(refname)", "refs/patches/stgit/adopt")
    .split("\n")
    .filter(Boolean);
  if (JSON.stringify(localRefs) !== JSON.stringify([...desiredRefs].sort())) {
    errors.push(
      "local patch refs must exactly match stack.json.applied; remove stale metadata refs",
    );
  }
  for (let index = 0; index < desiredRefs.length; index += 1) {
    const desiredRef = desiredRefs[index];
    if (desiredRef === undefined) continue;
    try {
      const oid = git("rev-parse", desiredRef);
      if (oid !== oids[index])
        errors.push(`${desiredRef} points to ${oid}, expected ${oids[index]}`);
    } catch (error) {
      errors.push(`${desiredRef} is missing: ${String(error)}`);
    }
  }

  if (errors.length > 0 || contextPatches.length !== applied.length || !base) return { errors };

  return {
    errors,
    context: {
      contract: "t3code.stgit-stack-context",
      version: 1,
      inventorySchema: 2,
      head,
      base,
      inventoryPath,
      instructionPaths,
      patches: contextPatches,
      roleOwners: Object.fromEntries(roleOwners),
    },
  };
};

export const checkStgitStack = (): string[] => inspectStgitStack().errors;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.length === 1 && args[0] === "--format=json";
  if (args.length > 0 && !json) {
    console.error("usage: scripts/ci/check-stgit-stack [--format=json]");
    process.exit(2);
  }
  const { errors, context } = inspectStgitStack();
  if (errors.length > 0) {
    for (const error of errors) console.error(`StGit stack: ${error}`);
    process.exit(1);
  }
  if (json) console.log(JSON.stringify(context, null, 2));
  else {
    const applied = (loadStack().applied as string[]).length;
    console.log(`StGit stack check PASS: ${applied} applied patches.`);
  }
}
