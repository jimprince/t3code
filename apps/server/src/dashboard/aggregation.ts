import { isNotAnswer } from "@t3tools/client-runtime/decision-comment";
import { aggregate as aggregateBase } from "@t3tools/client-runtime/dashboard/aggregation";
import { decisionReadyParts } from "../projectIssues/decisionReady.logic.ts";
import { DEFAULT_DECISION_OPTIONS, type DashboardAttention } from "@t3tools/contracts";
import { issueId } from "@t3tools/client-runtime/dashboard/progress";
export {
  BriefingPlan,
  briefingPlanRoot,
  dashboardRoots,
  rootRepositories,
  trackerSuccessors,
} from "@t3tools/client-runtime/dashboard/aggregation";

const standardActions = new Map<string, string>([
  ["passed", "approve"],
  ["works", "approve"],
  ["approve", "approve"],
  ["failed", "reject"],
  ["broken", "reject"],
  ["reject", "reject"],
  ["not yet", "not-yet"],
  ["got it", "approve"],
]);

/** Server-owned answer data; shared aggregation retains older clients' rows. */
export function aggregate(input: Parameters<typeof aggregateBase>[0]) {
  const snapshot = aggregateBase(input);
  const issues = new Map(
    [...input.issues.values()].flatMap((rows) =>
      rows.map((issue) => [issueId(issue.host, issue.repository, issue.number), issue] as const),
    ),
  );
  const asks = new Map<string, NonNullable<typeof input.pendingAsks>[number]>(
    (input.pendingAsks ?? []).map((ask) => [ask.requestId, ask]),
  );
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      attention: project.attention.map((item): DashboardAttention => {
        if (item.requestId !== null) {
          const ask = asks.get(item.requestId);
          if (!ask) return item;
          return ask.kind === "question"
            ? {
                ...item,
                answer: "thread-question",
                summary: item.question,
                judgingWhere: null,
                recommended: null,
                asksNothingYet: !item.question.trim(),
                questions: ask.questions,
                messageResponse: ask.messageResponse,
              }
            : {
                ...item,
                answer: "thread-approval",
                summary: item.question,
                judgingWhere: null,
                recommended: null,
                asksNothingYet: !item.question.trim(),
                ...(ask.options ? { approvalOptions: ask.options } : {}),
              };
        }
        const issue = issues.get(item.taskId);
        if (!issue) return item;
        const labels = new Set(issue.labels);
        const category = issue.decision
          ? "choice"
          : item.kind === "test"
            ? "test"
            : labels.has("ask:task")
              ? "review"
              : labels.has("ask:question")
                ? "answers"
                : labels.has("ask:epic") || labels.has("ask:plan")
                  ? "approve"
                  : "review";
        const ready = decisionReadyParts(
          issue.title,
          issue.decision?.context ||
            issue.readyComment?.body ||
            (issue.latestComment && !isNotAnswer(issue.latestComment.body)
              ? issue.latestComment.body
              : undefined),
        );
        const proposed = issue.decision?.options.length
          ? issue.decision.options
          : ready.options.map((option) => ({
              text: option.text,
              recommended: [option.label, option.label.replace(/^Option /, ""), option.text].some(
                (label) => label.toLowerCase() === ready.recommendation?.toLowerCase(),
              ),
            }));
        const modes = {
          choice: "issue-choice",
          review: "issue-review",
          approve: "issue-approve",
          answers: "issue-read",
          test: "issue-test",
        } as const;
        const defaults = category === "choice" ? [] : DEFAULT_DECISION_OPTIONS[category];
        return {
          ...item,
          answer: modes[category],
          question: ready.asksNothingYet ? "" : ready.detail.slice(0, 1500),
          summary: ready.summary,
          judgingWhere: ready.judgingWhere,
          recommended:
            ready.recommended ?? proposed.find((option) => option.recommended)?.text ?? null,
          asksNothingYet: ready.asksNothingYet,
          options: proposed.length
            ? proposed.map((option) => {
                // Preserve producer labels; an explicitly named standard action keeps
                // its consequence (e.g. proposed Passed still confirms the test).
                const actionWord = option.text
                  .trim()
                  .toLowerCase()
                  .match(/^(not yet|got it|\w+)\b/)?.[1];
                const standard = defaults.find(
                  (choice) => choice.action === standardActions.get(actionWord ?? ""),
                );
                return {
                  ...option,
                  action: standard?.action ?? ("option" as const),
                  ...(standard && "effect" in standard ? { effect: standard.effect } : {}),
                };
              })
            : defaults,
        };
      }),
    })),
  };
}
