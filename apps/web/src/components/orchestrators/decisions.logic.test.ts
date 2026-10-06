import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveDecisions } from "./decisions.logic";

const issue = (number: number, over: Partial<ProjectIssue> = {}): ProjectIssue => ({
  host: "gitea.example",
  repository: "brad/work",
  number,
  title: `Question ${number}`,
  url: `https://gitea.example/brad/work/issues/${number}`,
  status: "pending",
  labels: ["needs-brad"],
  isRequest: false,
  requestSource: null,
  assignees: [],
  comments: 0,
  createdAt: `2026-10-0${number}T10:00:00.000Z`,
  updatedAt: `2026-10-0${number}T10:00:00.000Z`,
  closedAt: null,
  linkedThreadIds: [],
  ...over,
});

const decision = { context: "why", waiting: "chief-of-staff-inbox", options: [] };

describe("deriveDecisions", () => {
  it("lists open issues that carry a decision, longest-waiting first", () => {
    const issues = [
      issue(3, { decision }),
      issue(1, { decision }),
      issue(2),
      issue(4, { decision, closedAt: "2026-10-05T00:00:00.000Z" }),
    ];
    expect(deriveDecisions(issues).map((entry) => entry.number)).toEqual([1, 3]);
  });
});
