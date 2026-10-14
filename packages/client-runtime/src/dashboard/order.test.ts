import { describe, expect, it } from "vite-plus/test";
import type { DashboardProject, DashboardTask, DashboardWorkstream } from "@t3tools/contracts";
import {
  applyMove,
  NEW_MARK_MS,
  isNewlyFiled,
  newMarkTitle,
  orderPlan,
  planMove,
  type PlaceStep,
  type PlaceTarget,
} from "./order.ts";

const id = (n: number) => `issue:git.test/brad/repo#${n}`;
const task = (n: number, extra: Partial<DashboardTask> = {}): DashboardTask => ({
  id: id(n),
  sourceId: "gitea:git.test/brad/repo",
  title: `Task ${n}`,
  url: null,
  threadId: null,
  workstreamId: "project:root:work",
  kind: "task",
  closedAt: null,
  status: "pending",
  progress: null,
  movement: {
    state: "unknown",
    doneDelta: null,
    windowMs: 0,
    fromAt: null,
    toAt: "2026-10-14T12:00:00.000Z",
  },
  forecast: null,
  nextStep: null,
  attentionIds: [],
  ...extra,
});
/** An issue that is not an ask: no type, so it is never "New". */
const plain = (n: number, extra: Partial<DashboardTask> = {}): DashboardTask => {
  const { kind: _kind, ...rest } = task(n, extra);
  return rest;
};
const workstream = (
  n: number | null,
  taskIds: string[],
  extra: Partial<DashboardWorkstream> = {},
): DashboardWorkstream =>
  n === null
    ? { id: "project:root:work", title: "Unsorted", taskIds }
    : { id: id(n), title: `Epic ${n}`, url: `https://git.test/${n}`, taskIds, ...extra };
const project = (
  tasks: DashboardTask[],
  workstreams: DashboardWorkstream[],
  planSource: "tracker" | "briefing" = "tracker",
): DashboardProject => ({
  planSource,
  id: "project:root",
  rootThreadId: null,
  parentId: null,
  title: "Root",
  utility: false,
  omittedTaskCount: 0,
  workstreams,
  tasks,
  attention: [],
  sourceIds: [],
});
const numbers = (tasks: DashboardTask[]) => tasks.map((t) => Number(/#(\d+)$/.exec(t.id)![1]));

describe("orderPlan", () => {
  it("numbers queued work by rank, then issue number, unranked last", () => {
    const tasks = [
      task(30, { rank: 3000 }),
      task(31, { rank: 1000 }),
      plain(32),
      task(29, { rank: 3000 }),
    ];
    const plan = orderPlan(
      project(tasks, [
        workstream(
          null,
          tasks.map((t) => t.id),
        ),
      ]),
    );
    expect(numbers(plan.workstreams[0]!.next)).toEqual([31, 29, 30, 32]);
  });

  it("puts started work first and keeps it out of the numbered queue", () => {
    const tasks = [task(1, { rank: 100 }), task(2, { rank: 500, status: "working" })];
    const [group] = orderPlan(
      project(tasks, [
        workstream(
          null,
          tasks.map((t) => t.id),
        ),
      ]),
    ).workstreams;
    expect(numbers(group!.now)).toEqual([2]);
    expect(numbers(group!.next)).toEqual([1]);
  });

  it("keeps a question out of New and the numbered queue, ranked or not", () => {
    const tasks = [task(1, { kind: "question" }), task(2, { kind: "question", rank: 10 }), task(3)];
    const [group] = orderPlan(
      project(tasks, [
        workstream(
          null,
          tasks.map((t) => t.id),
        ),
      ]),
    ).workstreams;
    expect(
      numbers(
        orderPlan(
          project(tasks, [
            workstream(
              null,
              tasks.map((t) => t.id),
            ),
          ]),
        ).fresh,
      ),
    ).toEqual([3]);
    expect(numbers(group!.now)).toEqual([2, 1]);
    expect(numbers(group!.next)).toEqual([]);
  });

  it("leaves the snapshot's own order when the server does not store it", () => {
    const tasks = [task(2, { rank: 5 }), task(1, { rank: 9 }), task(3)];
    const plan = orderPlan(
      project(tasks, [
        workstream(
          null,
          tasks.map((t) => t.id),
        ),
      ]),
      false,
    );
    expect(plan.ordered).toBe(false);
    expect(plan.fresh).toEqual([]);
    expect(numbers(plan.workstreams[0]!.next)).toEqual([2, 1, 3]);
  });

  it("sections unranked asks into New, newest first, and leaves ranked and parked ones out", () => {
    const tasks = [
      task(1, { createdAt: "2026-10-14T09:00:00.000Z" }),
      task(2, { createdAt: "2026-10-14T11:00:00.000Z" }),
      task(3, { rank: 10 }),
      task(4, { parked: true }),
      task(5, { status: "working" }),
      plain(6),
    ];
    const plan = orderPlan(
      project(tasks, [
        workstream(
          null,
          tasks.map((t) => t.id),
        ),
      ]),
    );
    expect(numbers(plan.fresh)).toEqual([2, 1]);
    expect(plan.later).toBe(1);
    expect(numbers(plan.workstreams[0]!.next)).toEqual([3, 6]);
    expect(numbers(plan.workstreams[0]!.now)).toEqual([5]);
  });

  it("keeps an unranked ask waiting on Brad where he can answer it, not in New", () => {
    const tasks = [
      task(1, { status: "blocked", attentionIds: ["a"] }),
      task(2, { status: "review" }),
    ];
    const plan = orderPlan(
      project(tasks, [
        workstream(
          null,
          tasks.map((t) => t.id),
        ),
      ]),
    );
    expect(plan.fresh).toEqual([]);
    expect(numbers(plan.workstreams[0]!.now)).toEqual([1, 2]);
  });

  it("orders epics by their own rank and leaves the non-epic group last", () => {
    const plan = orderPlan(
      project(
        [task(5, { workstreamId: "project:root:work" })],
        [
          workstream(null, [id(5)]),
          workstream(10, [], { rank: 5000 }),
          workstream(11, [], { rank: 1000 }),
          workstream(12, []),
        ],
      ),
    );
    expect(plan.workstreams.map((entry) => entry.workstream.id)).toEqual([
      id(11),
      id(10),
      id(12),
      "project:root:work",
    ]);
  });

  it("leaves a briefing plan in the snapshot's order with no New block", () => {
    const tasks = [plain(9), plain(2)];
    const plan = orderPlan(
      project(
        tasks,
        [
          workstream(
            null,
            tasks.map((t) => t.id),
          ),
        ],
        "briefing",
      ),
    );
    expect(plan.ordered).toBe(false);
    expect(plan.fresh).toEqual([]);
    expect(numbers(plan.workstreams[0]!.next)).toEqual([9, 2]);
  });

  it("does not list an epic's own kept task as a row", () => {
    const tasks = [task(10, { status: "blocked", attentionIds: ["a"] }), task(11, { rank: 1 })];
    const plan = orderPlan(
      project(tasks, [workstream(10, [id(10), id(11)]), workstream(null, [])]),
    );
    expect(numbers(plan.workstreams[0]!.next)).toEqual([11]);
    expect(plan.workstreams[0]!.now).toEqual([]);
  });
});

describe("applyMove", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("gives the order a move leaves", () => {
    expect(applyMove(list, "c", { to: "up" })).toEqual(["a", "c", "b"]);
    expect(applyMove(list, "a", { to: "down" })).toEqual(["b", "a", "c"]);
    expect(applyMove(list, "c", { to: "top" })).toEqual(["c", "a", "b"]);
    expect(applyMove(list, "a", { to: "bottom" })).toEqual(["b", "c", "a"]);
    expect(applyMove(list, "a", { to: "after", id: "c" })).toEqual(["b", "c", "a"]);
  });
  it("leaves the list alone when there is nowhere to go, and takes an arriving item in", () => {
    expect(applyMove(list, "a", { to: "up" })).toEqual(["a", "b", "c"]);
    expect(applyMove(list, "c", { to: "down" })).toEqual(["a", "b", "c"]);
    expect(applyMove(list, "a", { to: "before", id: "nope" })).toEqual(["a", "b", "c"]);
    expect(applyMove(list, "z", { to: "before", id: "b" })).toEqual(["a", "z", "b", "c"]);
  });
});

describe("planMove", () => {
  const list = [
    { id: "a", rank: 1 },
    { id: "b", rank: 2 },
    { id: "c", rank: 3 },
  ];
  const step = (stepId: string, place: PlaceTarget): PlaceStep => ({ id: stepId, place });

  it("moves to the ends with a single placement", () => {
    expect(planMove(list, "c", { to: "top" })).toEqual([step("c", { to: "top" })]);
    expect(planMove(list, "a", { to: "bottom" })).toEqual([step("a", { to: "bottom" })]);
  });

  it("writes nothing for a move to where the item already is", () => {
    expect(planMove(list, "a", { to: "top" })).toEqual([]);
    expect(planMove(list, "c", { to: "bottom" })).toEqual([]);
    expect(planMove(list, "a", { to: "up" })).toEqual([]);
    expect(planMove(list, "c", { to: "down" })).toEqual([]);
  });

  it("moves one step relative to the neighbour", () => {
    expect(planMove(list, "b", { to: "up" })).toEqual([step("b", { to: "before", id: "a" })]);
    expect(planMove(list, "b", { to: "down" })).toEqual([step("b", { to: "after", id: "c" })]);
    expect(planMove(list, "a", { to: "after", id: "c" })).toEqual([
      step("a", { to: "after", id: "c" }),
    ]);
  });

  it("ranks the unranked items in one batch before moving relative to them", () => {
    const mixed = [{ id: "a", rank: 1 }, { id: "x" }, { id: "y", rank: null }];
    expect(planMove(mixed, "y", { to: "up" })).toEqual([
      { rank: ["x", "y"] },
      step("y", { to: "before", id: "x" }),
    ]);
  });

  it("sends a first move in a wholly unranked list as one call with the final order", () => {
    const unranked = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(planMove(unranked, "c", { to: "up" })).toEqual([{ rank: ["a", "c", "b"], moved: "c" }]);
    expect(planMove(unranked, "a", { to: "down" })).toEqual([
      { rank: ["b", "a", "c"], moved: "a" },
    ]);
  });

  it("places an arriving item relative to a row of another workstream's list", () => {
    expect(planMove(list, "z", { to: "before", id: "b" })).toEqual([
      step("z", { to: "before", id: "b" }),
    ]);
    expect(planMove(list, "z", { to: "before", id: "nope" })).toEqual([]);
  });
});

describe("the new mark", () => {
  const filed = "2026-10-14T09:00:00.000Z";
  it("lasts four hours from the created time and then expires without any write", () => {
    const at = Date.parse(filed);
    expect(isNewlyFiled(filed, at + NEW_MARK_MS - 1)).toBe(true);
    expect(isNewlyFiled(filed, at + NEW_MARK_MS)).toBe(false);
    expect(isNewlyFiled(undefined, at)).toBe(false);
    expect(isNewlyFiled("not a date", at)).toBe(false);
  });

  it("names who placed the item, or says nobody has", () => {
    expect(newMarkTitle({ rank: 1, placedBy: { kind: "brad" } })).toBe("New, placed by Brad");
    expect(newMarkTitle({ rank: 1, placedBy: { kind: "agent", name: "T3 Orchestrator" } })).toBe(
      "New, placed by T3 Orchestrator",
    );
    expect(newMarkTitle({ rank: null, placedBy: null })).toBe("New, not placed yet");
    expect(newMarkTitle({ rank: 4 })).toBe("New, placer unknown");
  });
});
