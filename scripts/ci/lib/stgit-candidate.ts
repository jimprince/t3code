// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export const candidateContract = "t3code.stgit-candidate/v1" as const;
export const inventoryPath = "docs/operations/fork-inventory.toml" as const;

export type CandidatePatch = {
  readonly name: string;
  readonly subject: string;
  readonly class: "product" | "divergence" | "upstream-bound";
  readonly purpose: string;
  readonly retireWhen: string;
  readonly dependsOn: readonly string[];
};

export type CandidateManifest = {
  readonly contract: typeof candidateContract;
  readonly baseMain: string;
  readonly baseStack: string;
  readonly candidate: string;
  readonly patch: CandidatePatch;
  readonly allowedPaths: readonly string[];
  readonly verification: readonly (readonly string[])[];
};

export type PatchIdentity = {
  readonly name: string;
  readonly subject: string;
  readonly oid: string;
};

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
};

const sha = (value: unknown, name: string): string => {
  const rendered = string(value, name);
  if (!/^[0-9a-f]{40}$/.test(rendered)) throw new Error(`${name} must be a full SHA-1`);
  return rendered;
};

const stringArray = (value: unknown, name: string): readonly string[] => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry, index) => string(entry, `${name}[${index}]`));
};

const safeRelativePath = (value: string, name: string): string => {
  if (
    NodePath.posix.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    value === ".git" ||
    value.startsWith(".git/")
  ) {
    throw new Error(`${name} must be a normalized repository-relative path`);
  }
  return value;
};

const uniqueSorted = (values: readonly string[], name: string): readonly string[] => {
  const result = [...new Set(values)].sort();
  if (result.length !== values.length) throw new Error(`${name} contains duplicate entries`);
  return result;
};

export const validateCandidateManifest = (value: unknown): CandidateManifest => {
  const root = object(value, "manifest");
  if (root.contract !== candidateContract)
    throw new Error(`manifest.contract must be ${candidateContract}`);
  const patchValue = object(root.patch, "manifest.patch");
  const name = string(patchValue.name, "manifest.patch.name");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error("manifest.patch.name must be a lowercase StGit patch name");
  const patchClass = string(patchValue.class, "manifest.patch.class");
  if (!new Set(["product", "divergence", "upstream-bound"]).has(patchClass))
    throw new Error("manifest.patch.class is invalid");
  const dependsOn = uniqueSorted(
    stringArray(patchValue.dependsOn, "manifest.patch.dependsOn"),
    "manifest.patch.dependsOn",
  );
  const rawPaths = stringArray(root.allowedPaths, "manifest.allowedPaths").map((path, index) =>
    safeRelativePath(path, `manifest.allowedPaths[${index}]`),
  );
  if (rawPaths.includes(inventoryPath))
    throw new Error(`${inventoryPath} is deployment-owned and must not be in allowedPaths`);
  const verificationValue = root.verification;
  if (!Array.isArray(verificationValue) || verificationValue.length === 0)
    throw new Error("manifest.verification must contain at least one argv command");
  const verification = verificationValue.map((command, index) => {
    if (!Array.isArray(command) || command.length === 0)
      throw new Error(`manifest.verification[${index}] must be a non-empty argv array`);
    return command.map((argument, argumentIndex) =>
      string(argument, `manifest.verification[${index}][${argumentIndex}]`),
    );
  });
  return {
    contract: candidateContract,
    baseMain: sha(root.baseMain, "manifest.baseMain"),
    baseStack: sha(root.baseStack, "manifest.baseStack"),
    candidate: sha(root.candidate, "manifest.candidate"),
    patch: {
      name,
      subject: string(patchValue.subject, "manifest.patch.subject"),
      class: patchClass as CandidatePatch["class"],
      purpose: string(patchValue.purpose, "manifest.patch.purpose"),
      retireWhen: string(patchValue.retireWhen, "manifest.patch.retireWhen"),
      dependsOn,
    },
    allowedPaths: uniqueSorted(rawPaths, "manifest.allowedPaths"),
    verification,
  };
};

export const assertCandidateScope = (
  allowedPaths: readonly string[],
  changedPaths: readonly string[],
): void => {
  const allowed = new Set([...allowedPaths, inventoryPath]);
  const unexpected = [...new Set(changedPaths)].filter((path) => !allowed.has(path)).sort();
  if (unexpected.length > 0)
    throw new Error(`candidate changed paths outside its manifest: ${unexpected.join(", ")}`);
};

export const assertPatchPrefixUnchanged = (
  before: readonly PatchIdentity[],
  after: readonly PatchIdentity[],
): void => {
  if (after.length !== before.length + 1)
    throw new Error(
      `candidate must add exactly one patch; expected ${before.length + 1}, got ${after.length}`,
    );
  for (let index = 0; index < before.length; index += 1) {
    if (JSON.stringify(before[index]) !== JSON.stringify(after[index]))
      throw new Error(`pre-existing patch ${index + 1} changed during candidate deployment`);
  }
};

const tomlArray = (values: readonly string[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

export const formatInventoryStanza = (patch: CandidatePatch): string =>
  [
    "[[patch]]",
    `name = ${JSON.stringify(patch.name)}`,
    `subject = ${JSON.stringify(patch.subject)}`,
    `class = ${JSON.stringify(patch.class)}`,
    `purpose = ${JSON.stringify(patch.purpose)}`,
    `retire_when = ${JSON.stringify(patch.retireWhen)}`,
    `depends_on = ${tomlArray(patch.dependsOn)}`,
    "roles = []",
    "",
  ].join("\n");
