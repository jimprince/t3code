// @effect-diagnostics nodeBuiltinImport:off -- Descriptor identity checks, lstat and O_NOFOLLOW enforce the read-only plan boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../serverSettings.ts";
import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

const FILE_BYTES = 256 * 1024;
const PLAN_COUNT = 100;
const RESULT_COUNT = 5;
const threadIds = (text: string) =>
  [
    ...text.matchAll(
      /(?<![a-zA-Z0-9:._-])(?:mcp:[a-zA-Z0-9-]+|thread:[a-zA-Z0-9:._-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![a-zA-Z0-9:._-])/giu,
    ),
  ].map((m) => m[0].toLowerCase());
const statusOf = (text: string) => {
  const value = text.trim().toLowerCase().replace(/[_-]/gu, " ");
  return value === "done" || value === "completed" || value === "complete" || value === "live"
    ? "done"
    : value === "in progress" || value === "running"
      ? "in progress"
      : value === "pending" ||
          value === "blocked" ||
          value === "partial" ||
          value === "held" ||
          value === "not started" ||
          value.startsWith("waiting on ")
        ? "pending"
        : null;
};
export interface FilePlanRecord {
  readonly planPath: string;
  readonly host: string;
  readonly mtime: number;
  readonly title: string;
  readonly status: string;
  readonly owners: readonly string[];
  readonly steps: readonly {
    id: string;
    outcome: string;
    owners: readonly string[];
    status: "done" | "in progress" | "pending";
    evidence: string;
  }[];
  readonly next: string;
  readonly results: readonly { path: string; mtime: number }[];
}
/** Only the canonical compact template qualifies; arbitrary markdown is not a plan. */
export function parsePlanFile(
  content: string,
  planPath: string,
  host: string,
): FilePlanRecord | null {
  const title = /^# ([^\n]+)$/mu.exec(content)?.[1];
  const status = /^Status:[ \t]*([^\n]+)$/mu.exec(content)?.[1]?.trim();
  const owner = /^Owner:[ \t]*([^\n]+)$/mu.exec(content)?.[1];
  const stepsSection = /^## Steps\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu.exec(content)?.[1];
  const resumePoint = /^## Action log and resume point\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu.exec(
    content,
  )?.[1];
  if (!title || !status || !owner || !stepsSection || !resumePoint?.trim()) return null;
  const owners = threadIds(owner).slice(0, 1);
  const rows = stepsSection.split("\n").filter((l) => l.trim().startsWith("|"));
  const columns = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/gu, "")
      .split(/(?<!\\)\|/u)
      .map((v) => v.trim().replace(/\\\|/gu, "|"));
  const header = columns(rows[0] ?? "");
  if (
    header.length !== 5 ||
    header[0] !== "ID" ||
    header[1] !== "Outcome" ||
    !header[2]?.startsWith("Owner") ||
    header[3] !== "Status" ||
    header[4] !== "Evidence / next action"
  )
    return null;
  if (
    columns(rows[1] ?? "").length !== 5 ||
    !columns(rows[1] ?? "").every((cell) => /^:?-{3,}:?$/u.test(cell))
  )
    return null;
  const steps: FilePlanRecord["steps"][number][] = [];
  for (const row of rows.slice(2)) {
    const cells = columns(row);
    const stepStatus = statusOf(cells[3] ?? "");
    if (cells.length !== 5 || !cells[0] || !cells[1] || !stepStatus) return null;
    steps.push({
      id: cells[0],
      outcome: cells[1],
      owners: threadIds(cells[2]!),
      status: stepStatus,
      evidence: cells[4]!,
    });
  }
  if (
    steps.length === 0 ||
    steps.length > 500 ||
    (owners.length === 0 && !steps.some((step) => step.owners.length > 0))
  )
    return null;
  return {
    planPath,
    host,
    mtime: 0,
    title,
    status,
    owners,
    steps,
    next:
      Array.from(resumePoint.matchAll(/^Next:[ \t]*([^\n]+)$/gmu))
        .at(-1)?.[1]
        ?.trim() ?? "",
    results: [],
  };
}
export function filePlanForThread(plans: readonly FilePlanRecord[], threadId: string) {
  const id = threadId.toLowerCase();
  const ownedSteps = (plan: FilePlanRecord) =>
    plan.owners.includes(id) ? plan.steps : plan.steps.filter((step) => step.owners.includes(id));
  const candidates = plans.filter(
    (plan) => plan.owners.includes(id) || plan.steps.some((step) => step.owners.includes(id)),
  );
  const unfinished = (plan: FilePlanRecord) =>
    ownedSteps(plan).some((step) => step.status !== "done");
  const plan = candidates.toSorted(
    (a, b) =>
      Number(unfinished(b)) - Number(unfinished(a)) ||
      b.mtime - a.mtime ||
      a.planPath.localeCompare(b.planPath),
  )[0];
  if (!plan) return null;
  const owner = plan.owners.includes(id);
  const short = (text: string, limit: number) => Array.from(text).slice(0, limit).join("");
  const steps = ownedSteps(plan);
  const current =
    steps.find((s) => s.status === "in progress") ?? steps.find((s) => s.status === "pending");
  return {
    threadId,
    steps,
    plan,
    owner,
    summary: {
      planPath: plan.planPath,
      host: plan.host,
      planTitle: short(plan.title, 300),
      status: short(plan.status, 50),
      done: steps.filter((s) => s.status === "done").length,
      total: steps.length,
      currentStep: current
        ? {
            id: short(current.id, 100),
            text: short(current.outcome, 500),
            status: current.status === "in progress" ? ("running" as const) : ("pending" as const),
          }
        : null,
      hasResumePoint: plan.next.length > 0,
    },
  };
}
export function enrichFilePlanShells(
  plans: readonly FilePlanRecord[],
  shells: readonly OrchestrationV2ThreadShell[],
) {
  return shells.map((shell) => {
    const found = filePlanForThread(plans, shell.id);
    return found
      ? {
          ...shell,
          filePlan: found.summary,
          todoProgress: {
            completed: found.summary.done,
            total: found.summary.total,
            currentStep: found.summary.currentStep,
          },
        }
      : shell;
  });
}
export class PlanFileService extends Context.Service<
  PlanFileService,
  {
    readonly scan: Effect.Effect<readonly FilePlanRecord[]>;
    readonly forThread: (threadId: ThreadId) => Effect.Effect<ReturnType<typeof filePlanForThread>>;
  }
>()("t3/orchestration-v2/PlanFileService") {}

/** Read-only bounded host filesystem access; symlinked task directories and files are excluded. */
export function makePlanFileService(
  root: Effect.Effect<string>,
  host = NodeOS.hostname(),
): PlanFileService["Service"] {
  const cache = new Map<string, { key: string; content: string }>();
  let cachedRoot = "";
  let until = 0;
  let cachedPlans: readonly FilePlanRecord[] = [];
  const readFile = async (rootPath: string, filename: string, readBody = true) => {
    if (
      NodePath.relative(rootPath, filename).startsWith("..") ||
      (!["PLAN.md"].includes(NodePath.basename(filename)) &&
        !NodePath.basename(filename).endsWith("-RESULT.md"))
    )
      return null;
    let file: NodeFSP.FileHandle | undefined;
    try {
      const before = await NodeFSP.lstat(filename);
      if (before.isSymbolicLink() || !before.isFile() || (readBody && before.size > FILE_BYTES))
        return null;
      const resolved = await NodeFSP.realpath(filename);
      if (!resolved.startsWith(rootPath + NodePath.sep)) return null;
      file = await NodeFSP.open(filename, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
      const stat = await file.stat();
      const after = await NodeFSP.lstat(filename);
      if (
        stat.ino !== after.ino ||
        stat.dev !== after.dev ||
        !stat.isFile() ||
        (readBody && stat.size > FILE_BYTES) ||
        (await NodeFSP.realpath(filename)) !== resolved
      )
        return null;
      // Results need validated paths/mtimes only; never read or cache their bodies.
      if (!readBody) return { content: "", mtime: stat.mtimeMs };
      const key = `${stat.ino}:${stat.dev}:${stat.mtimeMs}:${stat.size}`;
      const hit = cache.get(filename);
      if (hit?.key === key) return { content: hit.content, mtime: stat.mtimeMs };
      const buffer = Buffer.alloc(FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > FILE_BYTES) return null;
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      if (cache.size >= 1000) cache.clear();
      cache.set(filename, { key, content });
      return { content, mtime: stat.mtimeMs };
    } catch {
      return null;
    } finally {
      await file?.close();
    }
  };
  const scan = Effect.gen(function* () {
    const directory = yield* root;
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.promise(async () => {
      try {
        if (!NodePath.isAbsolute(directory)) return [];
        const rootPath = await NodeFSP.realpath(directory);
        if (rootPath === cachedRoot && now < until) return cachedPlans;
        const plans: FilePlanRecord[] = [];
        const entries = await NodeFSP.readdir(rootPath, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1000)) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || plans.length >= PLAN_COUNT)
            continue;
          try {
            const folder = NodePath.join(rootPath, entry.name);
            if (
              (await NodeFSP.lstat(folder)).isSymbolicLink() ||
              (await NodeFSP.realpath(folder)) !== folder
            )
              continue;
            const text = await readFile(rootPath, NodePath.join(folder, "PLAN.md"));
            if (!text) continue;
            const plan = parsePlanFile(text.content, NodePath.join(folder, "PLAN.md"), host);
            if (!plan) continue;
            const filenames = (await NodeFSP.readdir(folder))
              .filter((name) => name.endsWith("-RESULT.md"))
              .sort()
              .slice(0, 1000);
            const candidates: { path: string; mtime: number }[] = [];
            for (const name of filenames) {
              const path = NodePath.join(folder, name);
              try {
                const stat = await NodeFSP.lstat(path);
                if (stat.isFile() && !stat.isSymbolicLink())
                  candidates.push({ path, mtime: stat.mtimeMs });
              } catch {
                /* A deleted result does not invalidate its plan. */
              }
            }
            const results: FilePlanRecord["results"][number][] = [];
            for (const candidate of candidates
              .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
              .slice(0, RESULT_COUNT)) {
              const result = await readFile(rootPath, candidate.path, false);
              if (result) results.push({ path: candidate.path, mtime: result.mtime });
            }
            plans.push({
              ...plan,
              mtime: text.mtime,
              results: results
                .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
                .slice(0, RESULT_COUNT),
            });
          } catch {
            /* A removed or unreadable task folder does not hide other plans. */
          }
        }
        cachedRoot = rootPath;
        cachedPlans = plans;
        until = now + 1000;
        return plans;
      } catch {
        return [] as readonly FilePlanRecord[];
      }
    });
  });
  return PlanFileService.of({
    scan,
    forThread: (threadId) => scan.pipe(Effect.map((plans) => filePlanForThread(plans, threadId))),
  });
}
export const layer = Layer.effect(
  PlanFileService,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    return makePlanFileService(
      settings.getSettings.pipe(
        Effect.map((s) =>
          s.planRootDirectory.startsWith("~/")
            ? NodePath.join(NodeOS.homedir(), s.planRootDirectory.slice(2))
            : s.planRootDirectory || NodePath.join(NodeOS.homedir(), "maintenance-work"),
        ),
        Effect.orElseSucceed(() => NodePath.join(NodeOS.homedir(), "maintenance-work")),
      ),
    );
  }),
);
