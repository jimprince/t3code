import { describe, expect, it } from "vite-plus/test";
import type { ProjectIssue } from "@t3tools/contracts";
import {
  compareOrder,
  RANK_GAP,
  editBeforeOrderTrailers,
  parseRankTrailer,
  parsePlacedByTrailer,
  planPlacement,
  replaceRankTrailer,
  replacePartOf,
  requestQueue,
  pickNext,
  orderedRequestList,
} from "./requestOrder.logic.ts";
const issue = (
  number: number,
  rank: number | null,
  extra: Partial<ProjectIssue> = {},
): ProjectIssue => ({
  host: "tracker.test",
  repository: "brad/example",
  number,
  title: `Task ${number}`,
  url: `https://tracker.test/brad/example/issues/${number}`,
  status: "pending",
  labels: ["ask", "ask:task"],
  isRequest: true,
  requestSource: null,
  assignees: [],
  comments: 0,
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  closedAt: null,
  linkedThreadIds: [],
  stage: "requested",
  rank,
  ...extra,
});
describe("tracker rank trailers", () => {
  it("reads only the last line and rejects invalid or unsafe ranks", () => {
    expect(parseRankTrailer("words\n<!-- t3:rank 3072 -->\n")).toBe(3072);
    expect(parseRankTrailer("<!-- t3:rank 3072 -->\nmore words")).toBeNull();
    expect(parseRankTrailer("<!-- t3:rank NaN -->")).toBeNull();
    expect(parseRankTrailer("<!-- t3:rank 9007199254740992 -->")).toBeNull();
  });
  it("preserves Brad's words and provenance, supports old ranks and sibling attribution", () => {
    const body =
      "Part of #8\n\n## Brad's words\n\n>  Fix this exactly  \n> \n\n<!-- t3-request abc -->";
    const placed = replaceRankTrailer(body, 3072, { kind: "brad" });
    expect(placed).toBe(
      `${body}\n<!-- t3:placed-by %7B%22kind%22%3A%22brad%22%7D -->\n<!-- t3:rank 3072 -->`,
    );
    expect(parseRankTrailer(placed)).toBe(3072);
    expect(parsePlacedByTrailer(placed)).toEqual({ kind: "brad" });
    expect(replaceRankTrailer(placed, 4096)).toContain("placed-by");
    expect(replaceRankTrailer(placed, null)).toBe(body);
    expect(replaceRankTrailer(`${body}\n<!-- t3:rank 1024 -->`, null)).toBe(body);
    expect(replaceRankTrailer(replaceRankTrailer(`${body}\n`, 1024), null)).toBe(`${body}\n`);
  });
  it("only changes the parent metadata line", () => {
    expect(replacePartOf("Part of #8\n\n> Part of #9\nbody", 10)).toBe(
      "Part of #10\n\n> Part of #9\nbody",
    );
  });
});
describe("sparse workstream order", () => {
  it("starts 1024 apart and inserts at the midpoint", () => {
    const one = issue(1, 1024),
      two = issue(2, 2048),
      moving = issue(3, null);
    expect(planPlacement([], moving, { to: "bottom" }).rank).toBe(RANK_GAP);
    expect(planPlacement([one], moving, { to: "bottom" }).rank).toBe(1024 + RANK_GAP);
    expect(planPlacement([one, two], moving, { to: "before", reference: "2" }, 2)).toEqual({
      writes: [{ number: 3, rank: 1536 }],
      rank: 1536,
      position: 2,
    });
    expect(planPlacement([one, two], moving, { to: "top" }).rank).toBe(1024 - RANK_GAP);
  });
  it("renumbers only supplied siblings when the integer gap runs out", () => {
    expect(
      planPlacement(
        [issue(1, 10), issue(2, 11)],
        issue(3, null),
        { to: "after", reference: "1" },
        1,
      ),
    ).toEqual({
      writes: [
        { number: 2, rank: 11 + 3 * RANK_GAP },
        { number: 3, rank: 11 + 2 * RANK_GAP },
        { number: 1, rank: 11 + RANK_GAP },
      ],
      rank: 11 + 2 * RANK_GAP,
      position: 2,
    });
    expect(() =>
      planPlacement([issue(1, null)], issue(2, null), { to: "after", reference: "1" }, 1),
    ).toThrow("ordered, queued sibling");
  });
  it("orders in-progress first, ties by issue number and unranked last", () => {
    expect(
      [issue(5, null), issue(4, 1024), issue(3, 1024), issue(2, null, { stage: "in-progress" })]
        .toSorted(compareOrder)
        .map((i) => i.number),
    ).toEqual([2, 3, 4, 5]);
  });
  it("keeps workstreams in rank order even when an epic is in progress", () => {
    const epic = (n: number, rank: number, stage: "requested" | "in-progress") =>
      issue(n, rank, { labels: ["ask", "ask:epic"], stage });
    const records = [
      epic(8, 2048, "in-progress"),
      epic(9, 1024, "requested"),
      issue(1, 1024, { partOf: 8 }),
      issue(2, 2048, { partOf: 9 }),
    ];
    expect(requestQueue(records).workstreams.map((ws) => ws.ws?.number ?? null)).toEqual([
      9,
      8,
      null,
    ]);
    expect(orderedRequestList(records).map((i) => i.number)).toEqual([9, 2, 8, 1]);
    expect(
      planPlacement(
        records.filter((i) => i.labels.includes("ask:epic")),
        epic(10, 3072, "requested"),
        { to: "bottom" },
      ).rank,
    ).toBe(3072);
  });
  it("does not pick started or review work when legacy child issues have no request stage", () => {
    const started = { ...issue(7, 1024, { partOf: 9, status: "in-progress", isRequest: false }) };
    delete started.stage;
    const review = { ...issue(6, 512, { partOf: 9, status: "needs-review", isRequest: false }) };
    delete review.stage;
    const queue = requestQueue([
      issue(9, 1024, { labels: ["ask", "ask:epic"] }),
      started,
      review,
      issue(8, 2048, { partOf: 9 }),
    ]);
    expect(queue.workstreams[0]?.now.map((i) => i.number)).toEqual([7]);
    expect(pickNext(queue)?.number).toBe(8);
  });
  it("groups now and next by ranked workstream and reports unranked asks as new", () => {
    const queue = requestQueue([
      issue(8, 2048, { labels: ["ask", "ask:epic"] }),
      issue(9, 1024, { labels: ["ask", "ask:epic"] }),
      issue(1, 1024, { partOf: 8 }),
      issue(2, 1024, { partOf: 9, blockedBy: [20] }),
      issue(20, null, { isRequest: false, labels: [] }),
      issue(3, 2048, { partOf: 9 }),
      issue(4, 0, { partOf: 9, stage: "in-progress" }),
      issue(5, null),
      issue(6, 1024),
    ]);
    expect(queue.workstreams.map((w) => w.ws?.number ?? null)).toEqual([9, 8, null]);
    expect(queue.workstreams[0]?.now.map((i) => i.number)).toEqual([4]);
    expect(queue.new.map((i) => i.number)).toEqual([5]);
    expect(pickNext(queue)?.number).toBe(3);
    expect(pickNext(requestQueue([issue(5, null)]))).toBeNull();
  });
});

it("removes and replaces every accepted parent line", () => {
  for (const prefix of ["Part of #12 (UI)", " Part of #12 (UI)", "\n Part of #12"]) {
    expect(replacePartOf(`${prefix}\n\nText`, null)).toBe("Text");
    expect(replacePartOf(`${prefix}\n\nText`, 30)).toBe("Part of #30\n\nText");
  }
});
it("recovers stranded duplicate trailer pairs and keeps only the newest pair last", () => {
  const pair = replaceRankTrailer("Body", 10, { kind: "brad" });
  const stranded = `${pair}\nDeferral\n<!-- t3:rank 20 -->\nMore text`;
  const result = editBeforeOrderTrailers(stranded, (body) => `${body}\nAttachment`);
  expect(parseRankTrailer(result)).toBe(20);
  expect(result.match(/t3:rank/g)).toHaveLength(1);
  expect(result.match(/t3:placed-by/g) ?? []).toHaveLength(0);
  expect(result).toContain("More text\nAttachment");
});
it("includes unranked migrated children and ignores known closed blockers", () => {
  const child = issue(2, null, { partOf: 8, isRequest: false, labels: [], blockedBy: [4] });
  const queue = requestQueue([
    issue(8, 1, { labels: ["ask:epic"] }),
    child,
    issue(4, null, { closedAt: "2026-10-14" }),
  ]);
  expect(queue.workstreams[0]?.next.map((i) => i.number)).toEqual([2]);
  expect(pickNext(queue)?.number).toBe(2);
});
it("keeps the original sibling order after every partial renumber prefix", () => {
  const originals = [issue(1, 10), issue(2, 11), issue(3, 12)];
  const plan = planPlacement(originals, issue(4, null), { to: "after", reference: "1" }, 1);
  for (let count = 0; count <= plan.writes.length; count++) {
    const ranks = new Map(originals.map((i) => [i.number, i.rank]));
    for (const write of plan.writes.slice(0, count)) ranks.set(write.number, write.rank);
    expect(
      originals
        .toSorted((a, b) => ranks.get(a.number)! - ranks.get(b.number)!)
        .map((i) => i.number),
    ).toEqual([1, 2, 3]);
  }
});

it("moves and removes marker-first published membership (#297 S2)", () => {
  const body = "<!-- t3-plan:thread -->\nPart of #5\n\n- [ ] Work\n<!-- t3:rank 100 -->";
  expect(replacePartOf(body, null)).toBe(
    "<!-- t3-plan:thread -->\n- [ ] Work\n<!-- t3:rank 100 -->",
  );
  const moved = replacePartOf(body, 7);
  expect(moved).toContain("<!-- t3-plan:thread -->\nPart of #7");
  expect(moved).not.toContain("Part of #5");
});
