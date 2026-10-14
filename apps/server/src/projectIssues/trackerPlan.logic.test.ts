import { describe, expect, it } from "vite-plus/test";
import {
  parseTrackerSteps,
  trackerPlan,
  confirmTrackerPlan,
  latestProgressNote,
  trackerDueDate,
  trackerCommentIssueNumber,
} from "./trackerPlan.logic.ts";

const now = "2026-10-14T10:00:00.000Z";
const row = { body: "- [x] One\n- [ ] Two", closed: false, stage: "requested", closedAt: null };
describe("tracker progress evidence (#297 constructed fixtures)", () => {
  it("ignores quoted and fenced checkboxes and keeps closed status separate from personal ticks", () => {
    expect(
      parseTrackerSteps("- [x] One\n> - [x] Quote\n~~~~md\n- [x] Fence\n~~~~\n- [ ] Two"),
    ).toEqual([
      { text: "One", checked: true },
      { text: "Two", checked: false },
    ]);
    expect(trackerPlan({ ...row, closed: true, closedAt: now })).toMatchObject({
      done: 1,
      total: 2,
    });
    expect(trackerPlan({ ...row, body: "", closed: true, closedAt: now })).toMatchObject({
      done: 1,
      total: 1,
      hasChecklist: false,
    });
  });
  it("orders recognized notes by creation and id, extracts only explicit next, and falls back to steps", () => {
    const comments = [
      { id: 2, body: "Progress: started", createdAt: now },
      { id: 3, body: "unrelated", createdAt: "2026-10-14T11:00:00.000Z" },
      { id: 1, body: "Progress: ready; next: Deploy 09:30Z", createdAt: now },
    ];
    expect(latestProgressNote(comments)).toMatchObject({ id: 2, nextStep: null });
    expect(trackerPlan({ ...row, note: latestProgressNote(comments) })).toMatchObject({
      nextStep: "Two",
      confirmedAt: now,
    });
    expect(
      trackerPlan({ ...row, body: "", note: latestProgressNote(comments) }).nextStep,
    ).toBeNull();
  });
  it("does not refresh confirmation on title/rank edits; changed steps and relevant stage confirm at observation", () => {
    const first = trackerPlan(row);
    expect(first.confirmedAt).toBeNull();
    const observed = confirmTrackerPlan(first, null, now);
    expect(
      confirmTrackerPlan(
        trackerPlan({ ...row, body: `${row.body}\n<!-- t3:rank 42 -->` }),
        observed,
        "2026-10-14T11:00:00.000Z",
      ).confirmedAt,
    ).toBeNull();
    const changed = confirmTrackerPlan(
      trackerPlan({ ...row, body: "- [x] One\n- [x] Two" }),
      observed,
      now,
    );
    expect(changed.confirmedAt).toBe(now);
    expect(changed.planVersion).toBe(first.planVersion);
    expect(trackerPlan({ ...row, body: "- [x] Other\n- [ ] Two" }).planVersion).not.toBe(
      first.planVersion,
    );
    expect(
      confirmTrackerPlan(trackerPlan({ ...row, stage: "ready" }), observed, now).confirmedAt,
    ).toBe(now);
  });
});

it("parses padded checkbox text in linear time (#297 B2)", () => {
  const start = performance.now();
  const steps = parseTrackerSteps("- [ ] a" + " ".repeat(40_000) + "b");
  expect(steps).toHaveLength(1);
  expect(performance.now() - start).toBeLessThan(100);
});

it("bounds bodies and actions without losing a useful checkbox (#297 B2/S4)", () => {
  const plan = trackerPlan({
    ...row,
    body: "- [ ] " + "x".repeat(50_000) + "\n" + "tail".repeat(50_000),
  });
  expect(plan.truncated).toBe(true);
  expect(plan.nextStep?.length).toBeLessThanOrEqual(500);
  expect(plan.nextStep?.startsWith("xxx")).toBe(true);
  const partial = trackerPlan({ ...row, body: "- [ ] " + "x".repeat(200_000) });
  expect(partial.nextStep).toBeNull();
  expect(partial.hasChecklist).toBe(false);
  expect(partial.total).toBe(1);
});

it("bounds every tracker regex path for pathological 256KiB and 1MiB inputs (#297 B2)", () => {
  for (const size of [256 * 1024, 1024 * 1024])
    for (const run of [" ", "- [ ] ", "[x]", "x", "a_a_a_", "http://", "\n"]) {
      const text = run.repeat(Math.ceil(size / run.length));
      const started = performance.now();
      parseTrackerSteps(text);
      parseTrackerSteps("- [ ] a" + text + "b");
      parseTrackerSteps("```" + text + "\n```\n> " + text);
      trackerPlan({ ...row, body: text });
      latestProgressNote([{ id: 1, createdAt: now, body: "Progress: " + text + " next: Work" }]);
      trackerDueDate(text);
      trackerCommentIssueNumber(text);
      trackerCommentIssueNumber("https://git.test/brad/repo/issues/" + text);
      expect(performance.now() - started, `${size}/${run}`).toBeLessThan(100);
    }
});
