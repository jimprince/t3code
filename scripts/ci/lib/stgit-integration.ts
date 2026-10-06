import { inventoryPath, type CandidatePatch } from "./stgit-candidate.ts";

export const integrationContract = "t3code.stgit-integration/v1" as const;

export type IntegrationConcern =
  | {
      readonly kind: "refresh";
      readonly candidate: string;
      readonly repo: string | undefined;
      readonly owner: string;
    }
  | {
      readonly kind: "new";
      readonly candidate: string;
      readonly repo: string | undefined;
      readonly patch: CandidatePatch;
    };

export type IntegrationPlan = {
  readonly contract: typeof integrationContract;
  readonly concerns: readonly IntegrationConcern[];
};

export type ConcernOutcome =
  | { readonly status: "applied"; readonly concern: IntegrationConcern }
  | { readonly status: "skipped"; readonly concern: IntegrationConcern; readonly reason: string };

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

const patchName = (value: unknown, name: string): string => {
  const rendered = string(value, name);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rendered))
    throw new Error(`${name} must be a lowercase StGit patch name`);
  return rendered;
};

export const validateIntegrationPlan = (value: unknown): IntegrationPlan => {
  const root = object(value, "plan");
  if (root.contract !== integrationContract)
    throw new Error(`plan.contract must be ${integrationContract}`);
  if (!Array.isArray(root.concerns) || root.concerns.length === 0)
    throw new Error("plan.concerns must be a non-empty array");
  const concerns = root.concerns.map((raw, index): IntegrationConcern => {
    const where = `plan.concerns[${index}]`;
    const entry = object(raw, where);
    const candidate = string(entry.candidate, `${where}.candidate`);
    if (!/^[0-9a-f]{40}$/.test(candidate))
      throw new Error(`${where}.candidate must be a full SHA-1`);
    const repo = entry.repo === undefined ? undefined : string(entry.repo, `${where}.repo`);
    if (entry.owner !== undefined) {
      if (entry.patch !== undefined) throw new Error(`${where} must name owner or patch, not both`);
      return { kind: "refresh", candidate, repo, owner: patchName(entry.owner, `${where}.owner`) };
    }
    const patch = object(entry.patch, `${where}.patch`);
    const patchClass = string(patch.class, `${where}.patch.class`);
    if (!new Set(["product", "divergence", "upstream-bound"]).has(patchClass))
      throw new Error(`${where}.patch.class is invalid`);
    const dependsOn = patch.dependsOn;
    if (!Array.isArray(dependsOn)) throw new Error(`${where}.patch.dependsOn must be an array`);
    return {
      kind: "new",
      candidate,
      repo,
      patch: {
        name: patchName(patch.name, `${where}.patch.name`),
        subject: string(patch.subject, `${where}.patch.subject`),
        class: patchClass as CandidatePatch["class"],
        purpose: string(patch.purpose, `${where}.patch.purpose`),
        retireWhen: string(patch.retireWhen, `${where}.patch.retireWhen`),
        dependsOn: dependsOn.map((dependency, i) =>
          patchName(dependency, `${where}.patch.dependsOn[${i}]`),
        ),
      },
    };
  });
  const candidates = concerns.map(({ candidate }) => candidate);
  if (new Set(candidates).size !== candidates.length)
    throw new Error("plan lists the same candidate twice");
  const names = concerns.flatMap((concern) => (concern.kind === "new" ? [concern.patch.name] : []));
  if (new Set(names).size !== names.length) throw new Error("plan creates the same patch twice");
  return { contract: integrationContract, concerns };
};

export const assertNewConcernPaths = (paths: readonly string[]): void => {
  if (paths.includes(inventoryPath))
    throw new Error(`${inventoryPath} is integration-owned for a new concern`);
};

export type ConcernOperations = {
  readonly apply: (concern: IntegrationConcern) => void;
  readonly check: () => void;
  readonly rollback: () => void;
};

/**
 * Applies each concern in order. A concern that fails to apply or to pass the
 * stack checks is rolled back and reported, so one bad concern never blocks
 * the rest of the batch. A failing rollback leaves the checkout in an unknown
 * state and aborts the whole run.
 */
export const integrateConcerns = (
  concerns: readonly IntegrationConcern[],
  operations: ConcernOperations,
): readonly ConcernOutcome[] =>
  concerns.map((concern): ConcernOutcome => {
    try {
      operations.apply(concern);
      operations.check();
      return { status: "applied", concern };
    } catch (error) {
      operations.rollback();
      return { status: "skipped", concern, reason: String(error) };
    }
  });
