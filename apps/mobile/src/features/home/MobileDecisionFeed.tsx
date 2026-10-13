import {
  approvalChoices,
  approvalTitle,
  oneTapQuestion,
  questionAnswers,
} from "@t3tools/client-runtime/decision-ask";
import { decisionAnswerInput, type DecisionPick } from "@t3tools/client-runtime/decision-answer";
import {
  asksWithFallbacks,
  buildDecisionFeed,
  clampMarkdownBlocks,
  decisionContextMarkdown,
  feedCardOwner,
  feedItemsOf,
  splitMarkdownBlocks,
  type DecisionFeedCard,
  type FeedPlanInput,
} from "@t3tools/client-runtime/decision-feed";
import { isNotAnswer, readyComment } from "@t3tools/client-runtime/decision-comment";
import { decisionVisibility } from "@t3tools/client-runtime/decision-deferral";
import { markdownBlockText } from "@t3tools/client-runtime/decision-markdown-text";
import {
  deliveryStrip,
  keptOutcomes,
  nextOutcomeExpiry,
  type FeedDelivery,
} from "@t3tools/client-runtime/decision-outcome";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectIssue,
  ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import { formatDeadline } from "@t3tools/shared/localTime";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import {
  mobileApproveMergeProjectRequest,
  mobileDecideProjectRequest,
  mobileDeferProjectRequest,
  mobileDiscussProjectRequest,
  mobilePendingAsks,
  mobileProjectIssues,
  mobileSendBackProjectRequest,
  mobileSettleProjectRequest,
} from "../../state/projectRequests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { MobileDecisionContext } from "./MobileDecisionContext";
import { MobileLinkifiedText } from "./MobileLinkifiedText";

const MAX_NOTE = 500;
const DAY_MS = 86_400_000;

const issueKey = (issue: ProjectIssue) => `${issue.repository}#${issue.number}`;

type Result =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

interface Outcome {
  readonly label: string;
  readonly delivery: FeedDelivery;
  readonly retry: (() => void) | null;
}

const KIND_LABEL: Record<DecisionFeedCard["kind"], string> = {
  question: "Question",
  approval: "Approval",
  plan: "Plan",
  decision: "Decision",
  answer: "Answer",
  review: "Review",
  test: "Test",
};

const age = (iso: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

/** The agent's summary or the thread's answer, never a progress or curator note. */
function answerText(issue: ProjectIssue): string {
  const comment = issue.latestComment;
  return comment && !isNotAnswer(comment.body) ? comment.body : (issue.answer?.text ?? "");
}

function Choice({
  label,
  detail,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly detail?: string | undefined;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: selected === true }}
      onPress={onPress}
      className={`min-h-11 justify-center rounded-md border px-2 py-2 ${selected ? "border-foreground" : "border-border"}`}
    >
      <Text className="text-sm text-foreground">
        <MobileLinkifiedText text={label} />
      </Text>
      {detail ? <Text className="text-xs text-foreground-muted">{detail}</Text> : null}
    </Pressable>
  );
}

function Action({
  label,
  disabled,
  onPress,
  quiet,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly quiet?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 justify-center ${quiet ? "" : "rounded-md border border-foreground px-4"} ${disabled ? "opacity-40" : ""}`}
    >
      <Text className={quiet ? "text-xs text-foreground-muted" : "text-sm text-foreground"}>
        {label}
      </Text>
    </Pressable>
  );
}

function Field({
  value,
  onChange,
  placeholder,
  max,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly max: number;
}) {
  return (
    <TextInput
      accessibilityLabel={placeholder}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColorClassName="accent-placeholder"
      maxLength={max}
      className="min-h-11 rounded-md border border-border px-2 py-2 text-sm font-sans text-foreground"
    />
  );
}

/** A decision's context as Markdown blocks (lead, list, table), folded by whole blocks. */
function CardContext({
  environmentId,
  markdown,
  issueUrl,
}: {
  readonly environmentId: EnvironmentId;
  readonly markdown: string;
  readonly issueUrl: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const blocks = useMemo(() => splitMarkdownBlocks(decisionContextMarkdown(markdown)), [markdown]);
  if (blocks.length === 0) return null;
  const { shown, hidden } = clampMarkdownBlocks(blocks);
  return (
    <View className="gap-1">
      <MobileDecisionContext
        environmentId={environmentId}
        text={(expanded ? blocks : shown).map(markdownBlockText).join("\n\n")}
        issueUrl={issueUrl}
        clamp={false}
      />
      {hidden > 0 ? (
        <Action
          quiet
          label={expanded ? "Less" : `More (${hidden})`}
          onPress={() => setExpanded((current) => !current)}
        />
      ) : null}
    </View>
  );
}

interface CardActions {
  readonly openThread: (threadId: ThreadId) => void;
  readonly act: (card: DecisionFeedCard, label: string, run: () => Promise<Result>) => void;
  readonly environmentId: EnvironmentId;
  readonly respondToUserInput: (
    ask: Extract<DecisionFeedCard, { kind: "question" }>["ask"],
    answers: Record<string, string>,
  ) => Promise<Result>;
  readonly respondToApproval: (
    ask: Extract<DecisionFeedCard, { kind: "approval" }>["ask"],
    decision: ProviderApprovalDecision,
  ) => Promise<Result>;
  readonly decide: (
    issue: ProjectIssue,
    decision: "approve" | "not-yet" | "option" | "answer",
    extra: { option?: string; answer?: string; reason?: string },
    told: string,
  ) => Promise<Result>;
  readonly settle: (issue: ProjectIssue) => Promise<Result>;
  readonly approveMerge: (issue: ProjectIssue) => Promise<Result>;
  readonly sendBack: (issue: ProjectIssue, note: string, told: string) => Promise<Result>;
  readonly defer: (
    issue: ProjectIssue,
    input: { mode: "until"; until: string } | { mode: "end" | "clear" },
  ) => Promise<Result>;
  readonly discuss: (issue: ProjectIssue) => void;
  readonly discussing: string | null;
}

function Controls({
  card,
  actions,
}: {
  readonly card: DecisionFeedCard;
  readonly actions: CardActions;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const told = feedCardOwner(card)?.name ?? "the project orchestrator";
  if (card.kind === "question") {
    const question = oneTapQuestion(card.ask);
    return (
      <View className="gap-1">
        {question?.options.map((option, index) => (
          <Choice
            key={option.label}
            label={option.label}
            detail={option.description}
            selected={selected === `o${index}`}
            onPress={() => setSelected(`o${index}`)}
          />
        ))}
        {question && question.allowCustomAnswer !== false ? (
          <>
            <Choice
              label="Other..."
              selected={selected === "other"}
              onPress={() => setSelected("other")}
            />
            {selected === "other" ? (
              <Field value={text} onChange={setText} placeholder="Your answer" max={2000} />
            ) : null}
          </>
        ) : null}
        <View className="flex-row items-center gap-3">
          {question ? (
            <Action
              label="Send"
              disabled={selected === null || (selected === "other" && !text.trim())}
              onPress={() => {
                const pick =
                  selected === "other"
                    ? ({ kind: "other", text } as const)
                    : ({ kind: "option", index: Number(selected?.slice(1)) } as const);
                const answers = questionAnswers(question, pick);
                if (answers) {
                  actions.act(card, "Answered", () =>
                    actions.respondToUserInput(card.ask, answers),
                  );
                }
              }}
            />
          ) : null}
          <Action quiet label="Open thread" onPress={() => actions.openThread(card.ask.threadId)} />
        </View>
      </View>
    );
  }
  if (card.kind === "approval") {
    return (
      <View className="gap-1">
        {card.ask.detail ? (
          <Text className="text-xs text-foreground" selectable>
            {card.ask.detail}
          </Text>
        ) : null}
        {card.ask.canRespond ? null : (
          <Text className="text-xs text-foreground-muted">
            {card.ask.requestId === "pending"
              ? "Open the thread to answer this."
              : "This request outlived its session: resolve it in the thread."}
          </Text>
        )}
        <View className="flex-row flex-wrap items-center gap-2">
          {card.ask.canRespond
            ? approvalChoices(card.ask).map((choice) => (
                <Action
                  key={choice.decision}
                  label={choice.label}
                  onPress={() =>
                    actions.act(card, choice.label, () =>
                      actions.respondToApproval(card.ask, choice.decision),
                    )
                  }
                />
              ))
            : null}
          <Action quiet label="Open thread" onPress={() => actions.openThread(card.ask.threadId)} />
        </View>
      </View>
    );
  }
  if (card.kind === "plan") {
    return (
      <Action
        label="Open thread"
        onPress={() => actions.openThread(card.plan.threadId as ThreadId)}
      />
    );
  }
  const { issue } = card;
  const asDecision = card.kind === "decision" && issue.decision !== undefined;
  if (asDecision) {
    const decision = issue.decision!;
    const open = decision.options.length === 0;
    const pick: DecisionPick | null = open
      ? { kind: "open", text }
      : selected === "other"
        ? { kind: "other", text }
        : selected !== null
          ? { kind: "option", option: selected }
          : null;
    const input = pick ? decisionAnswerInput(pick, note) : null;
    return (
      <View className="gap-1">
        {open
          ? null
          : decision.options.map((option) => (
              <Choice
                key={option.text}
                label={option.text}
                detail={option.recommended ? "Recommended" : undefined}
                selected={selected === option.text}
                onPress={() => setSelected(option.text)}
              />
            ))}
        {open ? null : (
          <Choice
            label="Other..."
            selected={selected === "other"}
            onPress={() => setSelected("other")}
          />
        )}
        {open || selected === "other" ? (
          <Field
            value={text}
            onChange={setText}
            placeholder={open ? "Answer" : "Your answer"}
            max={2000}
          />
        ) : null}
        {noteOpen ? (
          <Field value={note} onChange={setNote} placeholder="Note" max={MAX_NOTE} />
        ) : null}
        <View className="flex-row items-center gap-3">
          <Action
            label="Send"
            disabled={!input}
            onPress={() => {
              if (!pick || !input) return;
              const given = (pick.kind === "option" ? pick.option : pick.text).trim();
              actions.act(card, `Answered: ${given}`, () =>
                actions.decide(
                  issue,
                  input.decision,
                  {
                    ...(input.option ? { option: input.option } : {}),
                    ...(input.answer ? { answer: input.answer } : {}),
                    ...(input.reason ? { reason: input.reason } : {}),
                  },
                  told,
                ),
              );
            }}
          />
          {noteOpen ? null : <Action quiet label="Add note" onPress={() => setNoteOpen(true)} />}
          <Action
            quiet
            disabled={actions.discussing === issueKey(issue)}
            label={actions.discussing === issueKey(issue) ? "Opening..." : "Discuss"}
            onPress={() => actions.discuss(issue)}
          />
        </View>
      </View>
    );
  }
  if (card.kind === "review") {
    return (
      <View className="gap-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Action
            label="Approve and merge"
            onPress={() =>
              actions.act(card, "Approve and merge", () => actions.approveMerge(issue))
            }
          />
          <Action quiet label="Send back" onPress={() => setNoteOpen((open) => !open)} />
          <Action
            quiet
            label="Settle without merging"
            onPress={() =>
              actions.act(card, "Settled without merging", () => actions.settle(issue))
            }
          />
        </View>
        {noteOpen ? (
          <>
            <Field value={note} onChange={setNote} placeholder="What to change" max={2000} />
            <Action
              label="Send back"
              disabled={!note.trim()}
              onPress={() =>
                actions.act(card, "Sent back with a note", () =>
                  actions.sendBack(issue, note, told),
                )
              }
            />
          </>
        ) : null}
      </View>
    );
  }
  if (card.kind === "test") {
    return (
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Action
            label="Works"
            onPress={() => actions.act(card, "Works", () => actions.settle(issue))}
          />
          <Action quiet label="Broken" onPress={() => setNoteOpen((open) => !open)} />
        </View>
        {noteOpen ? (
          <>
            <Field value={note} onChange={setNote} placeholder="What broke" max={2000} />
            <Action
              label="Send back"
              disabled={!note.trim()}
              onPress={() =>
                actions.act(card, "Sent back: broken", () =>
                  actions.sendBack(issue, `Broken: ${note.trim()}`, told),
                )
              }
            />
          </>
        ) : null}
      </View>
    );
  }
  // Answers and plans or epics marked for approval.
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {card.approve ? (
        <>
          {readyComment(issue).options.length === 0 ? (
            <Action
              label="Approve"
              onPress={() =>
                actions.act(card, "Approved", () => actions.decide(issue, "approve", {}, told))
              }
            />
          ) : (
            readyComment(issue).options.map((option) => (
              <Action
                key={option.label}
                label={`${option.label}: ${option.text}`}
                onPress={() =>
                  actions.act(card, `Chose ${option.label}`, () =>
                    actions.decide(
                      issue,
                      "option",
                      { option: `${option.label}: ${option.text}` },
                      told,
                    ),
                  )
                }
              />
            ))
          )}
          <Action
            quiet
            label="Not yet"
            onPress={() =>
              actions.act(card, "Not yet", () => actions.decide(issue, "not-yet", {}, told))
            }
          />
        </>
      ) : (
        <Action
          label="Settle"
          onPress={() => actions.act(card, "Settled", () => actions.settle(issue))}
        />
      )}
      <Action
        quiet
        label="Open thread"
        onPress={() => issue.owner && actions.openThread(issue.owner.threadId)}
      />
    </View>
  );
}

function FeedCard({
  card,
  now,
  outcome,
  actions,
  onDrop,
}: {
  readonly card: DecisionFeedCard;
  readonly now: number;
  readonly outcome: Outcome | null;
  readonly actions: CardActions;
  readonly onDrop: () => void;
}) {
  const owner = feedCardOwner(card);
  const meta = [
    card.blocked
      ? `${owner?.name ?? "A thread"} is blocked on this`
      : `For ${owner?.name ?? "the project orchestrator"}${owner?.project ? ` in ${owner.project}` : ""}`,
    age(card.since, now),
    !card.blocked && card.issue.decision?.deadline
      ? formatDeadline(card.issue.decision.deadline, now)
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const title =
    card.kind === "question"
      ? (card.ask.questions[0]?.question ?? `${card.ask.threadTitle} has a question`)
      : card.kind === "approval"
        ? approvalTitle(card.ask)
        : card.kind === "plan"
          ? `${card.plan.title}: plan ready for review`
          : card.issue.title;
  const body = card.blocked
    ? ""
    : card.kind === "decision" && card.issue.decision
      ? card.issue.decision.context
      : card.kind === "test"
        ? card.testStep
          ? `Test: ${card.testStep}`
          : ""
        : card.approve
          ? readyComment(card.issue).detail
          : answerText(card.issue);
  const strip = outcome ? deliveryStrip(outcome.delivery) : null;
  const itemIssue = card.blocked ? null : card.issue;
  return (
    <View className="gap-1 border-t border-border pt-2">
      <Text className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
        {KIND_LABEL[card.kind]}
      </Text>
      <Text className="text-sm text-foreground">{title}</Text>
      <Text className="text-xs text-foreground-muted">{meta}</Text>
      {itemIssue && body ? (
        <CardContext
          environmentId={actions.environmentId}
          markdown={body}
          issueUrl={itemIssue.url}
        />
      ) : null}
      {outcome && strip ? (
        <>
          <Text className="text-sm text-foreground">{outcome.label}</Text>
          <Text
            className={`text-xs ${strip.retryable ? "text-danger-foreground" : "text-foreground-muted"}`}
          >
            {strip.text}
          </Text>
          {strip.retryable ? (
            <View className="flex-row items-center gap-3">
              {outcome.retry ? <Action label="Retry" onPress={outcome.retry} /> : null}
              <Action quiet label="Choose again" onPress={onDrop} />
            </View>
          ) : null}
        </>
      ) : (
        <>
          <Controls card={card} actions={actions} />
          {itemIssue ? <LaterRow issue={itemIssue} card={card} actions={actions} /> : null}
        </>
      )}
    </View>
  );
}

/** Later (a day) and Move to end for an issue card; nobody is told. */
function LaterRow({
  issue,
  card,
  actions,
}: {
  readonly issue: ProjectIssue;
  readonly card: DecisionFeedCard;
  readonly actions: CardActions;
}) {
  const until = new Date(Date.now() + DAY_MS).toISOString();
  // A card due within a day comes back at once, so Later would not hide it.
  const hides = decisionVisibility({
    deferral: { until, movedToEndAt: null },
    deadline: issue.decision?.deadline,
    now: Date.now(),
  }).hidden;
  return (
    <View className="flex-row items-center gap-3">
      {hides ? (
        <Action
          quiet
          label="Later: 1 day"
          onPress={() =>
            actions.act(card, "Later: 1 day", () => actions.defer(issue, { mode: "until", until }))
          }
        />
      ) : (
        <Text className="text-xs text-foreground-muted">Due within a day</Text>
      )}
      <Action
        quiet
        label="Move to end"
        onPress={() => void actions.defer(issue, { mode: "end" })}
      />
    </View>
  );
}

/**
 * Everything waiting on Brad under a project, as one feed: threads' questions and
 * approvals, plans, decisions, and answers / reviews / tests. Acting on a card keeps it
 * on screen showing what happened (Sent, or the server's reason with Retry) until a later
 * read no longer has it. Later cards are listed at the foot with Bring back.
 */
export function MobileDecisionFeed({
  summary,
  onOpenThread,
}: {
  readonly summary: OrchestratorSummary;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const environmentId = summary.root.environmentId;
  const issuesQuery = useEnvironmentQuery(
    mobileProjectIssues({ environmentId, input: { rootThreadId: summary.root.id } }),
  );
  const waiting = useMemo(
    () => summary.needsYou.filter((item) => item.kind === "approval" || item.kind === "input"),
    [summary.needsYou],
  );
  const signature = waiting
    .map((item) => `${item.kind}:${item.thread.id}`)
    .sort()
    .join(",");
  const asksQuery = useEnvironmentQuery(
    signature ? mobilePendingAsks({ environmentId, input: { threadId: summary.root.id } }) : null,
  );
  const refreshAsks = asksQuery.refresh;
  const refreshIssues = issuesQuery.refresh;
  // The query reads on mount; a later change to who is waiting reads again.
  const seenSignature = useRef(signature);
  useEffect(() => {
    const previous = seenSignature.current;
    seenSignature.current = signature;
    if (previous === signature || previous === "") return;
    if (signature) refreshAsks();
  }, [signature, refreshAsks]);
  // Later cards return on their own: the issues list is not polled, so the clock ticks here.
  const [minute, setMinute] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setMinute(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const now = Math.max(issuesQuery.dataUpdatedAt ?? 0, minute);
  const readAt = asksQuery.data === null ? now : Math.min(now, asksQuery.dataUpdatedAt ?? now);
  const titles = useMemo(
    () => new Map(summary.projects.map((entry) => [entry.id as string, entry.title])),
    [summary.projects],
  );
  const feed = useMemo(() => {
    const titleOf = (projectId: string) => titles.get(projectId) ?? "";
    const issues = issuesQuery.data?.issues ?? [];
    const plans: FeedPlanInput[] = summary.needsYou
      .filter((item) => item.kind === "plan")
      .map((item) => ({
        threadId: item.thread.id,
        title: item.thread.title,
        projectTitle: titleOf(item.thread.projectId),
        since: item.thread.updatedAt,
      }));
    return buildDecisionFeed({
      asks: asksWithFallbacks({
        returned: asksQuery.data?.asks ?? [],
        loading: asksQuery.isPending && asksQuery.data === null,
        waiting: waiting.map((item) => ({
          kind: item.kind === "approval" ? "approval" : "input",
          threadId: item.thread.id,
          title: item.thread.title,
          projectTitle: titleOf(item.thread.projectId),
          updatedAt: item.thread.updatedAt,
        })),
      }),
      plans,
      decisions: issues.filter((issue) => issue.decision !== undefined && issue.closedAt === null),
      items: feedItemsOf(issues),
      now,
      project: null,
    });
  }, [
    asksQuery.data,
    asksQuery.isPending,
    issuesQuery.data,
    now,
    summary.needsYou,
    titles,
    waiting,
  ]);

  const decide = useAtomCommand(mobileDecideProjectRequest, "Decide");
  const discussCommand = useAtomCommand(mobileDiscussProjectRequest, "Discuss");
  const settleCommand = useAtomCommand(mobileSettleProjectRequest, "Settle");
  const approveMergeCommand = useAtomCommand(mobileApproveMergeProjectRequest, "Approve and merge");
  const sendBackCommand = useAtomCommand(mobileSendBackProjectRequest, "Send back");
  const deferCommand = useAtomCommand(mobileDeferProjectRequest, "Later");
  const respondToUserInputCommand = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const respondToApprovalCommand = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );

  const [outcomes, setOutcomes] = useState<
    ReadonlyMap<string, Outcome & { card: DecisionFeedCard; index: number }>
  >(new Map());
  const liveKeys = useMemo(() => new Set(feed.cards.map((card) => card.key)), [feed.cards]);
  // A sent card leaves once a list read after it no longer has it and it has been on screen
  // long enough to read; a timer re-checks when the earliest one is due.
  const [clock, setClock] = useState(0);
  const kept = keptOutcomes(outcomes, liveKeys, readAt, clock);
  useEffect(() => {
    setOutcomes((current) => keptOutcomes(current, liveKeys, readAt, clock));
  }, [liveKeys, readAt, clock]);
  useEffect(() => {
    const next = nextOutcomeExpiry(outcomes, clock);
    if (next === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [outcomes, clock]);
  const record = (
    key: string,
    entry: (Outcome & { card: DecisionFeedCard; index: number }) | null,
  ) =>
    setOutcomes((current) => {
      const next = new Map(current);
      if (entry) next.set(key, entry);
      else next.delete(key);
      return next;
    });

  const failure = (result: unknown): Result => {
    const error = squashAtomCommandFailure(result as never);
    return {
      ok: false,
      error:
        error instanceof Error && error.message ? error.message : "Could not reach the server.",
    };
  };
  const refresh = () => {
    refreshIssues();
    refreshAsks();
  };
  const [discussing, setDiscussing] = useState<string | null>(null);

  const actions: CardActions = {
    environmentId,
    openThread: onOpenThread,
    discussing,
    discuss: (issue) => {
      if (discussing !== null) return;
      setDiscussing(issueKey(issue));
      void discussCommand({
        environmentId,
        input: { threadId: summary.root.id, reference: issueKey(issue) },
      })
        .then((result) => {
          if (result._tag === "Success") onOpenThread(result.value.threadId);
        })
        .finally(() => setDiscussing(null));
    },
    act: (card, label, run) => {
      const key = card.key;
      const index = Math.max(
        0,
        feed.cards.findIndex((candidate) => candidate.key === key),
      );
      const execute = async () => {
        const base = { card, index, label };
        record(key, { ...base, delivery: { phase: "sending" }, retry: null });
        const result = await run();
        record(key, {
          ...base,
          delivery: result.ok
            ? { phase: "sent", at: Date.now(), text: result.text }
            : { phase: "failed", error: result.error },
          retry: result.ok ? null : () => void execute(),
        });
        refresh();
      };
      void execute();
    },
    respondToUserInput: async (ask, answers) => {
      const result = await respondToUserInputCommand({
        environmentId,
        input: { threadId: ask.threadId, requestId: ask.requestId, answers },
      });
      return result._tag === "Success"
        ? { ok: true, text: `Sent to ${ask.threadTitle}` }
        : failure(result);
    },
    respondToApproval: async (ask, decision) => {
      const result = await respondToApprovalCommand({
        environmentId,
        input: { threadId: ask.threadId, requestId: ask.requestId, decision },
      });
      return result._tag === "Success"
        ? { ok: true, text: `Sent to ${ask.threadTitle}` }
        : failure(result);
    },
    decide: async (issue, kind, extra, told) => {
      const result = await decide({
        environmentId,
        input: { threadId: summary.root.id, reference: issueKey(issue), decision: kind, ...extra },
      });
      return result._tag === "Success"
        ? {
            ok: true,
            text:
              result.value.notifiedThreadId !== null
                ? `Sent to ${told}`
                : `Posted on the issue; ${told} was not found`,
          }
        : failure(result);
    },
    settle: async (issue) => {
      const result = await settleCommand({
        environmentId,
        input: {
          rootThreadId: summary.root.id,
          host: issue.host,
          repository: issue.repository,
          number: issue.number,
        },
      });
      return result._tag === "Success"
        ? { ok: true, text: `Settled #${issue.number}` }
        : failure(result);
    },
    approveMerge: async (issue) => {
      const result = await approveMergeCommand({
        environmentId,
        input: { threadId: summary.root.id, reference: issueKey(issue) },
      });
      return result._tag === "Success"
        ? {
            ok: true,
            text: `Merged PR ${result.value.pullRequest.number} and settled #${issue.number}`,
          }
        : failure(result);
    },
    sendBack: async (issue, note, told) => {
      const result = await sendBackCommand({
        environmentId,
        input: { threadId: summary.root.id, reference: issueKey(issue), note },
      });
      return result._tag === "Success"
        ? {
            ok: true,
            text: result.value.viaOrchestrator
              ? "Sent back to the project orchestrator (its worker is gone)"
              : `Sent back to ${told}`,
          }
        : failure(result);
    },
    defer: async (issue, input) => {
      const result = await deferCommand({
        environmentId,
        input: { threadId: summary.root.id, reference: issueKey(issue), ...input },
      });
      refresh();
      return result._tag === "Success"
        ? { ok: true, text: "Hidden until it returns" }
        : failure(result);
    },
  };

  const shown = [...feed.cards];
  for (const entry of [...kept.values()].sort((a, b) => a.index - b.index)) {
    if (!liveKeys.has(entry.card.key))
      shown.splice(Math.min(entry.index, shown.length), 0, entry.card);
  }
  const [showLater, setShowLater] = useState(false);
  if (shown.length === 0 && feed.later.length === 0) return null;
  return (
    <View className="mt-2 gap-2">
      <Text className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
        Decisions {feed.total}
      </Text>
      {shown.map((card) => (
        <FeedCard
          key={card.key}
          card={card}
          now={now}
          outcome={kept.get(card.key) ?? null}
          actions={actions}
          onDrop={() => record(card.key, null)}
        />
      ))}
      {feed.later.length > 0 ? (
        <View className="gap-1">
          <Action
            quiet
            label={showLater ? "Hide Later" : `Later ${feed.later.length}`}
            onPress={() => setShowLater((open) => !open)}
          />
          {showLater
            ? feed.later.map(({ card }) =>
                card.blocked ? null : (
                  <View key={card.key} className="flex-row items-center gap-2">
                    <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
                      {card.issue.title}
                    </Text>
                    <Action
                      quiet
                      label="Bring back"
                      onPress={() => void actions.defer(card.issue, { mode: "clear" })}
                    />
                  </View>
                ),
              )
            : null}
        </View>
      ) : null}
    </View>
  );
}
