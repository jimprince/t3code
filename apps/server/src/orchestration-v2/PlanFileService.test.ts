// @effect-diagnostics nodeBuiltinImport:off -- Integration fixtures exercise real files, mtimes and symlink refusal.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { DashboardSnapshot, ThreadId } from "@t3tools/contracts";
import { makePlanFileService, filePlanForThread, parsePlanFile } from "./PlanFileService.ts";
import { buildFilePlanResumeSeed, redactSeedText } from "./ThreadResumeSeed.ts";

const parent = "11111111-1111-4111-8111-111111111111";
const worker = "mcp:22222222-2222-4222-8222-222222222222";
const child = "thread:delegated-task:33333333-3333-4333-8333-333333333333";
// Shape copied from the actual canonical workflow.md compact template; content is synthetic.
export const compactPlanFixture = (owner = parent, firstWorker = worker) => `# Synthetic task
Status: in progress
Owner: Synthetic parent ${owner}, host: test-host
Updated: 2026-10-13
Authority: Synthetic test only

## Scope and constraints
Parent alone edits this file.

## Steps
| ID | Outcome | Owner / actual task or thread ID | Status | Evidence / next action |
| --- | --- | --- | --- | --- |
| inspect | Inspect source | ${firstWorker} | done | Tested |
| build | Build source | ${firstWorker} | in progress | Verify write |
| verify | Verify results | ${child} | pending | Run checks |

## Checks and artifacts
Synthetic evidence.

## Blockers and decisions
None.

## Action log and resume point
Completed inspect; build may be in flight.
Next: Verify prior write before repeating.
`;
const decodeSnapshot = Schema.decodeUnknownEffect(DashboardSnapshot);
const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-file-plan-")),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    return yield* use(root);
  }).pipe(Effect.scoped);

it.effect(
  "reads compact template files, maps all ID styles and separates parent and worker progress",
  () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const folder = NodePath.join(root, "task");
        yield* Effect.promise(() => NodeFSP.mkdir(folder));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(folder, "PLAN.md"), compactPlanFixture()),
        );
        const service = makePlanFileService(Effect.succeed(root), "test-host");
        const plans = yield* service.scan;
        assert.lengthOf(plans, 1);
        const owner = yield* service.forThread(ThreadId.make(parent));
        const own = yield* service.forThread(ThreadId.make(worker));
        const delegated = yield* service.forThread(ThreadId.make(child));
        assert.deepEqual([owner?.summary.done, owner?.summary.total], [1, 3]);
        assert.deepEqual([own?.summary.done, own?.summary.total], [1, 2]);
        assert.equal(own?.summary.currentStep?.text, "Build source");
        assert.deepEqual([delegated?.summary.done, delegated?.summary.total], [0, 1]);
        assert.equal(delegated?.summary.currentStep?.status, "pending");
        assert.isNull(yield* service.forThread(ThreadId.make(worker + "-suffix")));
        assert.isTrue(owner?.summary.hasResumePoint);
        assert.isNull(parsePlanFile("# Not a plan\n- [ ] task", "PLAN.md", "test"));
      }),
    ),
);

it.effect(
  "refuses symlink files/directories, outside-root and nested plans, and reads only allowed results",
  () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const outside = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-file-plan-outside-")),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(outside, "PLAN.md"), compactPlanFixture()),
        );
        yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(root, "escape")));
        const folder = NodePath.join(root, "task");
        yield* Effect.promise(() => NodeFSP.mkdir(folder));
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(outside, "PLAN.md"), NodePath.join(folder, "PLAN.md")),
        );
        assert.lengthOf(yield* makePlanFileService(Effect.succeed(root)).scan, 0);
        yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(folder, "PLAN.md")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(folder, "PLAN.md"), compactPlanFixture()),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(
            NodePath.join(outside, "PLAN.md"),
            NodePath.join(folder, "escape-RESULT.md"),
          ),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(folder, "secret.txt"), "UNRELATED SECRET"),
        );
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(folder, "nested")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(folder, "nested", "PLAN.md"), compactPlanFixture()),
        );
        const plans = yield* makePlanFileService(Effect.succeed(root)).scan;
        assert.lengthOf(plans, 1);
        assert.lengthOf(plans[0]!.results, 0);
        assert.lengthOf(yield* makePlanFileService(Effect.succeed("../outside")).scan, 0);
      }),
    ),
);

it.effect(
  "lists newest allowed result paths without copying bodies and retains ownership instructions",
  () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const folder = NodePath.join(root, "task");
        yield* Effect.promise(() => NodeFSP.mkdir(folder));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(folder, "PLAN.md"),
            compactPlanFixture().replace(
              "Completed inspect;",
              "AKIAIOSFODNN7EXAMPLE Completed inspect;",
            ) +
              "\n" +
              "ordinary detail ".repeat(3000),
          ),
        );
        for (let i = 0; i < 7; i++) {
          const path = NodePath.join(folder, `${i}-RESULT.md`);
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              path,
              `# Synthetic worker result\nChanged: synthetic source\nEvidence: result-${i} ghp_syntheticcredential0123456789\nNeed: none\nUnknown: none\n` +
                "result detail ".repeat(1000),
            );
            await NodeFSP.utimes(path, 100 + i, 100 + i);
          });
        }
        const service = makePlanFileService(Effect.succeed(root), "test-host");
        const found = yield* service.forThread(ThreadId.make(worker));
        assert.isNotNull(found);
        const seed = buildFilePlanResumeSeed(found!);
        assert.include(seed, "Source: file plan");
        assert.include(seed, `Source thread: ${worker}`);
        const owned = seed.slice(
          seed.indexOf("Steps owned by the source thread:"),
          seed.indexOf("Plan path:"),
        );
        assert.include(owned, "Inspect source");
        assert.include(owned, "Build source");
        assert.notInclude(owned, "Verify results");
        assert.include(seed, `test-host:${folder}/PLAN.md`);
        assert.include(seed, "Next: Verify prior write");
        assert.include(seed, "Create NO new plan file");
        assert.include(seed, "only if you are the plan Owner");
        assert.include(seed, "own RESULT file");
        assert.notInclude(seed, "ordinary detail");
        assert.notInclude(seed, "ghp_syntheticcredential");
        assert.notInclude(seed, "AKIAIOSFODNN7EXAMPLE");
        assert.notInclude(seed, "result detail");
        assert.isBelow(seed.indexOf("6-RESULT.md"), seed.indexOf("5-RESULT.md"));
        assert.notInclude(seed, "0-RESULT.md");
        assert.lengthOf(found!.plan.results, 5);
        const oversized = NodePath.join(root, "large");
        yield* Effect.promise(() => NodeFSP.mkdir(oversized));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(oversized, "PLAN.md"),
            compactPlanFixture() + "x".repeat(300000),
          ),
        );
        assert.lengthOf(yield* makePlanFileService(Effect.succeed(root)).scan, 1);
        const snapshot = yield* decodeSnapshot({
          revision: 1,
          asOf: "2026-10-13T00:00:00Z",
          projects: [],
          releases: [],
          sources: [],
          filePlans: { [worker]: found!.summary },
        });
        assert.equal(snapshot.filePlans?.[worker]?.currentStep?.text, "Build source");
        const old = yield* decodeSnapshot({
          revision: 1,
          asOf: "2026-10-13T00:00:00Z",
          projects: [],
          releases: [],
          sources: [],
        });
        assert.isUndefined(old.filePlans);
        assert.isNull(filePlanForThread([], worker));
      }),
    ),
);

it.effect("accepts the real canonical parent template shape including partial steps", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      // Sanitized shape of dev-vm maintenance-work/plan-progress/PLAN.md, read 2026-10-13.
      // No private task text or real worker IDs are retained.
      const text = compactPlanFixture()
        .replace("| verify | Verify results", "| partial | Partial proof")
        .replace(`| ${child} | pending |`, `| ${child} | partial |`);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(`${root}/task`);
        await NodeFSP.writeFile(`${root}/task/PLAN.md`, text);
      });
      const found = yield* makePlanFileService(Effect.succeed(root)).forThread(
        ThreadId.make(child),
      );
      assert.equal(found?.summary.total, 1);
      assert.equal(found?.summary.done, 0);
      assert.equal(found?.summary.currentStep?.text, "Partial proof");
    }),
  ),
);

it.effect("caps plan count and observes changed file mtimes after the scan cache expires", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 105 }, async (_, i) => {
            const folder = `${root}/${String(i).padStart(3, "0")}`;
            await NodeFSP.mkdir(folder);
            await NodeFSP.writeFile(`${folder}/PLAN.md`, compactPlanFixture());
          }),
        ),
      );
      const service = makePlanFileService(Effect.succeed(root));
      assert.lengthOf(yield* service.scan, 100);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          `${root}/000/PLAN.md`,
          compactPlanFixture().replace("Build source", "Changed source"),
        ),
      );
      yield* TestClock.adjust("1100 millis");
      assert.equal(
        (yield* service.forThread(ThreadId.make(worker)))?.summary.currentStep?.text,
        "Changed source",
      );
    }),
  ),
);

it.effect(
  "parses annotated headers and held/waiting statuses seen in the real template corpus",
  () =>
    withRoot((root) =>
      Effect.gen(function* () {
        // Sanitized status/ownership shapes from three additional depth-one host plans.
        for (const status of ["held", "not started", "waiting on Brad"]) {
          const folder = `${root}/${status.replaceAll(" ", "-")}`;
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(folder);
            await NodeFSP.writeFile(
              `${folder}/PLAN.md`,
              compactPlanFixture("Synthetic owner without receipt")
                .replace("Status: in progress", "Status: in progress (held checks)")
                .replace(`| ${child} | pending |`, `| ${child} | ${status} |`),
            );
          });
        }
        const plans = yield* makePlanFileService(Effect.succeed(root)).scan;
        assert.lengthOf(plans, 3);
        for (const plan of plans)
          assert.equal(filePlanForThread([plan], child)?.summary.currentStep?.status, "pending");
      }),
    ),
);

it.effect("bounds the source-owned seed steps and names the current step", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const rows = Array.from(
        { length: 120 },
        (_, i) =>
          `| step-${i} | ${"detail ".repeat(100)} | ${worker} | pending | Synthetic evidence |`,
      ).join("\n");
      const text = compactPlanFixture().replace(
        /\| inspect \|[\s\S]*?\n\n## Checks/u,
        rows + "\n\n## Checks",
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(`${root}/task`);
        await NodeFSP.writeFile(`${root}/task/PLAN.md`, text);
      });
      const found = yield* makePlanFileService(Effect.succeed(root)).forThread(
        ThreadId.make(worker),
      );
      assert.equal(found?.summary.total, 120);
      const seed = buildFilePlanResumeSeed(found!);
      const owned = seed.slice(
        seed.indexOf("Steps owned by the source thread:"),
        seed.indexOf("Plan path:"),
      );
      assert.lengthOf(
        owned.split("\n").filter((line) => line.startsWith("- [")),
        100,
      );
      assert.include(owned, "20 additional owned steps omitted");
      for (const line of owned.split("\n").filter((line) => line.startsWith("- [")))
        assert.isBelow(line.length, 650);
      assert.include(seed, "- [pending] step-0:");
      assert.include(seed, "Work only on unfinished steps owned by the source thread");
    }),
  ),
);

it.effect("keeps only the bounded owned rows, last Next and absolute paths inside one fence", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const rows = "Build source " + "long outcome ".repeat(100);
      const next = "Verify newest receipt " + "next detail ".repeat(100);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(`${root}/task`);
        await NodeFSP.writeFile(
          `${root}/task/PLAN.md`,
          compactPlanFixture()
            .replace("Build source", rows)
            .replace(
              "Next: Verify prior write before repeating.",
              `Next: stale action\nNext: ${next}`,
            ),
        );
        await NodeFSP.writeFile(`${root}/task/worker-RESULT.md`, "RESULT BODY must stay local");
      });
      const found = yield* makePlanFileService(Effect.succeed(root), "test-host").forThread(
        ThreadId.make(worker),
      );
      const seed = buildFilePlanResumeSeed(found!);
      assert.include(seed, `Source thread: ${worker}`);
      assert.include(seed, "Build source");
      assert.notInclude(seed, "Verify results");
      assert.include(seed, `Plan path: test-host:${root}/task/PLAN.md`);
      assert.include(seed, `Result path: test-host:${root}/task/worker-RESULT.md`);
      assert.include(seed, "Plan title: Synthetic task");
      assert.include(seed, "Plan status: in progress");
      assert.include(seed, "Next: Verify newest receipt");
      assert.notInclude(seed, "Next: stale action");
      assert.notInclude(seed, "RESULT BODY");
      assert.notProperty(found!.plan, "content");
      assert.notProperty(found!.plan, "resumePoint");
      assert.notProperty(found!.plan.results[0]!, "content");
      const lines = seed.split("\n");
      const fence = lines.find((line) => /^`{3,}text$/u.test(line))!.slice(0, -4);
      assert.equal(lines.filter((line) => line === fence).length, 1);
      assert.isAbove(seed.indexOf("Read the listed files first"), seed.lastIndexOf(fence));
      for (const line of lines.filter((line) => line.startsWith("- [") || line.startsWith("Next:")))
        assert.isBelow(line.length, 650);
      assert.include(seed, "[truncated]");
      assert.include(seed, "Create NO new plan file");
    }),
  ),
);

it.effect("maps only the current Owner before replaced handover IDs, ignoring case", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const current = "abcdefab-cdef-4abc-8def-abcdefabcdef";
      const replaced = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(`${root}/task`);
        await NodeFSP.writeFile(
          `${root}/task/PLAN.md`,
          compactPlanFixture(
            `${current.toUpperCase()}; replaced ${replaced} on 2026-10-13, usage limit`,
          ),
        );
      });
      const service = makePlanFileService(Effect.succeed(root));
      assert.isNull(yield* service.forThread(ThreadId.make(replaced)));
      assert.isTrue((yield* service.forThread(ThreadId.make(current)))?.owner);
      assert.equal(
        (yield* service.forThread(ThreadId.make(worker.toUpperCase())))?.summary.total,
        2,
      );
    }),
  ),
);

it.effect("selects unfinished owned steps before newest PLAN mtime across several plans", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        for (const [folder, content, mtime] of [
          [
            "a-complete",
            compactPlanFixture()
              .replaceAll("in progress |", "done |")
              .replaceAll("pending |", "done |"),
            300,
          ],
          ["b-old", compactPlanFixture(), 100],
          ["c-current", compactPlanFixture(), 200],
        ] as const) {
          await NodeFSP.mkdir(`${root}/${folder}`);
          await NodeFSP.writeFile(`${root}/${folder}/PLAN.md`, content);
          await NodeFSP.utimes(`${root}/${folder}/PLAN.md`, mtime, mtime);
        }
      });
      const service = makePlanFileService(Effect.succeed(root));
      for (const id of [parent, worker])
        assert.equal(
          (yield* service.forThread(ThreadId.make(id)))?.summary.planPath,
          `${root}/c-current/PLAN.md`,
        );
    }),
  ),
);

it.effect("keeps only the last Next line and explains a missing Next", () =>
  withRoot((root) =>
    Effect.gen(function* () {
      const log =
        "Next: stale instruction\n" +
        "older log detail ".repeat(800) +
        "\nNext: Verify newest receipt.\n";
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(`${root}/task`);
        await NodeFSP.writeFile(
          `${root}/task/PLAN.md`,
          compactPlanFixture().replace(/Completed inspect;[\s\S]*/u, log),
        );
      });
      const found = yield* makePlanFileService(Effect.succeed(root)).forThread(
        ThreadId.make(worker),
      );
      assert.equal(found?.plan.next, "Verify newest receipt.");
      const seed = buildFilePlanResumeSeed(found!);
      assert.include(seed, "Next: Verify newest receipt.");
      assert.notInclude(seed, "Next: stale instruction");
      assert.notInclude(seed, "older log detail");
      assert.include(seed, "continue from the LAST Next:");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          `${root}/task/PLAN.md`,
          compactPlanFixture().replace(
            "Next: Verify prior write before repeating.",
            "Resume point: inspect the evidence.",
          ),
        ),
      );
      const missing = yield* makePlanFileService(Effect.succeed(root)).forThread(
        ThreadId.make(worker),
      );
      assert.isFalse(missing?.summary.hasResumePoint);
      assert.include(buildFilePlanResumeSeed(missing!), "There is no Next: line");
    }),
  ),
);

const reviewCredentialCorpus = [
  ["env hex", `GITEA_TOKEN=${"0123456789abcdef".repeat(2)}01234567`],
  ["CLI token", `tea login --token ${"0123456789abcdef".repeat(2)}01234567`],
  ["Authorization token", `Authorization: token ${"0123456789abcdef".repeat(2)}01234567`],
  ["camel token", `giteaToken: ${"0123456789abcdef".repeat(2)}01234567`],
  ["client secret", `clientSecret="${"0123456789abcdef".repeat(2)}01234567"`],
  ["db password", "dbPassword=hunter2"],
  ["AWS base64", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
  [
    "Telegram URL",
    "https://api.telegram.org/bot123456789:AAHsyntheticToken0123456789ABCDE/sendMessage",
  ],
  ["capability URL", "https://example.com/dl/SyntheticCapabilityToken0123456789ABC/file.tgz"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.SyntheticSignature0123456789AB"],
  ["Stripe", ["sk_", "live_", "SyntheticStripeCredential0123456789"].join("")],
  ["GitHub", "ghp_SyntheticCredential0123456789AB"],
  ["Slack webhook", "https://hooks.slack.com/services/T123/B456/SyntheticCredential0123456789"],
  ["Discord webhook", "https://discord.com/api/webhooks/123456/SyntheticCredential0123456789"],
  ["PEM", "-----BEGIN PRIVATE KEY-----\nSYNTHETIC PRIVATE MATERIAL\n-----END PRIVATE KEY-----"],
  ["database URL", "postgres://synthetic:hunter2@db/x"],
  ["password flag", "mysql -uroot -phunter2 --password hunter2"],
];
it.effect.each(reviewCredentialCorpus.map(([label, secret]) => ({ label, secret: secret! })))(
  "never embeds PLAN/action/result body credential $label",
  ({ secret }) =>
    withRoot((root) =>
      Effect.gen(function* () {
        const body = `BODY_MUST_STAY_LOCAL\n${secret}\nEND_OF_LOCAL_BODY`;
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(`${root}/task`);
          await NodeFSP.writeFile(
            `${root}/task/PLAN.md`,
            compactPlanFixture()
              .replace("Synthetic evidence.", body)
              .replace("Completed inspect; build may be in flight.", body),
          );
          await NodeFSP.writeFile(`${root}/task/worker-RESULT.md`, body);
        });
        const found = yield* makePlanFileService(Effect.succeed(root)).forThread(
          ThreadId.make(worker),
        );
        const seed = buildFilePlanResumeSeed(found!);
        assert.notInclude(seed, secret);
        assert.notInclude(seed, "BODY_MUST_STAY_LOCAL");
        assert.notInclude(seed, "END_OF_LOCAL_BODY");
        assert.include(seed, "Build source");
        assert.include(seed, "Next: Verify prior write");
        assert.include(seed, `${root}/task/worker-RESULT.md`);
      }),
    ),
);

it.effect.each([
  "a_",
  "plan_step_",
  "fix-thread-plan-",
  "http://",
  "-----BEGIN PRIVATE KEY-----\n",
])("builds bounded seeds and filters 256KiB pathological input %s below 200ms", (unit) =>
  withRoot((root) =>
    Effect.gen(function* () {
      const pathological = unit.repeat(Math.ceil(262144 / unit.length)).slice(0, 262144);
      const template = compactPlanFixture();
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(`${root}/task`);
        await NodeFSP.writeFile(
          `${root}/task/PLAN.md`,
          template + pathological.slice(template.length),
        );
        await NodeFSP.writeFile(`${root}/task/worker-RESULT.md`, pathological);
      });
      const found = yield* makePlanFileService(Effect.succeed(root)).forThread(
        ThreadId.make(worker),
      );
      assert.isNotNull(found);
      const start = performance.now();
      const seed = buildFilePlanResumeSeed(found!);
      // The native fallback uses this same production filter; it must also be linear
      // on unbounded provider text, independently of the file-body omission.
      redactSeedText(pathological);
      const elapsed = performance.now() - start;
      assert.isBelow(elapsed, 200);
      assert.include(seed, "Build source");
      assert.isBelow(seed.length, 5000);
    }),
  ),
);
