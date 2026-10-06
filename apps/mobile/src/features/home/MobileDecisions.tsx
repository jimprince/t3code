import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  decisionAnswerInput,
  decisionSendStrip,
  keptDecisionAnswers,
  sentDelivery,
  waitingLabel,
  type DecisionAnswerInput,
  type DecisionAnswerRecord,
  type DecisionPick,
} from "@t3tools/client-runtime/decision-answer";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectIssue, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MobileLinkifiedText } from "./MobileLinkifiedText";
import { MobileDecisionContext } from "./MobileDecisionContext";
import {
  mobileDecideProjectRequest,
  mobileDiscussProjectRequest,
  mobileProjectIssues,
} from "../../state/projectRequests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const MAX_NOTE = 500;

const issueKey = (issue: ProjectIssue) => `${issue.repository}#${issue.number}`;

type Selection = { readonly kind: "option"; readonly option: string } | { readonly kind: "other" };

function DecisionCard({
  environmentId,
  issue,
  waiting,
  answer,
  onSend,
  onRetry,
  onDrop,
  discussing,
  onDiscuss,
}: {
  readonly environmentId: EnvironmentId;
  readonly issue: ProjectIssue;
  /** Who the answer goes to, in words. */
  readonly waiting: string;
  /** The answer given on this card, shown instead of the options until the card leaves. */
  readonly answer: DecisionAnswerRecord<ProjectIssue> | null;
  readonly onSend: (answered: string, input: DecisionAnswerInput) => void;
  readonly onRetry: () => void;
  /** Gives up on a failed answer and shows the options again. */
  readonly onDrop: () => void;
  readonly discussing: boolean;
  readonly onDiscuss: () => void;
}) {
  const decision = issue.decision!;
  const open = decision.options.length === 0;
  const [selected, setSelected] = useState<Selection | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const pick: DecisionPick | null = open
    ? { kind: "open", text }
    : selected?.kind === "option"
      ? { kind: "option", option: selected.option }
      : selected?.kind === "other"
        ? { kind: "other", text }
        : null;
  const input = pick ? decisionAnswerInput(pick, note) : null;
  const send = () => {
    if (!pick || !input) return;
    onSend(`Answered: ${(pick.kind === "option" ? pick.option : pick.text).trim()}`, input);
  };
  const strip = answer ? decisionSendStrip(answer.delivery, waiting) : null;
  const showText = open || selected?.kind === "other";
  return (
    <View className="gap-1 border-t border-border pt-2">
      <Text className="text-sm text-foreground">{issue.title}</Text>
      {decision.context ? (
        <MobileDecisionContext
          environmentId={environmentId}
          text={decision.context}
          issueUrl={issue.url}
        />
      ) : null}
      {answer && strip ? (
        <>
          <Text className="text-sm text-foreground">{answer.answered}</Text>
          <Text
            className={`text-xs ${strip.retryable ? "text-danger-foreground" : "text-foreground-muted"}`}
          >
            {strip.text}
          </Text>
          {strip.retryable ? (
            <View className="flex-row items-center gap-3">
              <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                className="min-h-11 justify-center rounded-md border border-foreground px-4"
              >
                <Text className="text-sm text-foreground">Retry</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={onDrop}
                className="min-h-11 justify-center"
              >
                <Text className="text-xs text-foreground-muted">Choose again</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : (
        <>
          {open
            ? null
            : decision.options.map((option) => {
                const active = selected?.kind === "option" && selected.option === option.text;
                return (
                  <Pressable
                    key={option.text}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => setSelected({ kind: "option", option: option.text })}
                    className={`min-h-11 flex-row items-center gap-2 rounded-md border px-2 py-2 ${active ? "border-foreground" : "border-border"}`}
                  >
                    <Text className="min-w-0 flex-1 text-sm text-foreground">
                      <MobileLinkifiedText text={option.text} />
                    </Text>
                    {option.recommended ? (
                      <Text className="text-xs text-foreground-muted">Recommended</Text>
                    ) : null}
                  </Pressable>
                );
              })}
          {open ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: selected?.kind === "other" }}
              onPress={() => setSelected({ kind: "other" })}
              className={`min-h-11 justify-center rounded-md border px-2 py-2 ${selected?.kind === "other" ? "border-foreground" : "border-border"}`}
            >
              <Text className="text-sm text-foreground">Other...</Text>
            </Pressable>
          )}
          {showText ? (
            <TextInput
              accessibilityLabel={open ? "Answer" : "Other answer"}
              value={text}
              onChangeText={setText}
              placeholder={open ? "Answer" : "Your answer"}
              placeholderTextColorClassName="accent-placeholder"
              maxLength={2000}
              className="min-h-11 rounded-md border border-border px-2 py-2 text-sm font-sans text-foreground"
            />
          ) : null}
          {noteOpen ? (
            <TextInput
              accessibilityLabel="Note"
              value={note}
              onChangeText={setNote}
              placeholder="Note"
              placeholderTextColorClassName="accent-placeholder"
              maxLength={MAX_NOTE}
              className="min-h-11 rounded-md border border-border px-2 py-2 text-sm font-sans text-foreground"
            />
          ) : null}
          <View className="flex-row items-center gap-3">
            <Pressable
              accessibilityRole="button"
              disabled={!input}
              onPress={send}
              className={`min-h-11 justify-center rounded-md border border-foreground px-4 ${!input ? "opacity-40" : ""}`}
            >
              <Text className="text-sm text-foreground">Send</Text>
            </Pressable>
            {noteOpen ? null : (
              <Pressable
                accessibilityRole="button"
                onPress={() => setNoteOpen(true)}
                className="min-h-11 justify-center"
              >
                <Text className="text-xs text-foreground-muted">Add note</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              disabled={discussing}
              onPress={onDiscuss}
              className="min-h-11 justify-center"
            >
              <Text className="text-xs text-foreground-muted">
                {discussing ? "Opening..." : "Discuss"}
              </Text>
            </Pressable>
            <Text className="flex-1 text-xs text-foreground-muted">For {waiting}</Text>
          </View>
        </>
      )}
    </View>
  );
}

/**
 * Decisions waiting on Brad (open needs-brad issues) under a project: pick an
 * option, Other... or type an answer, optionally add a note, and Send. The answer is
 * commented on the issue and sent to the waiting thread; the card shows the answer
 * until a list read after it was sent no longer has the issue, and a failure stays on
 * the card with the server's reason and Retry. Discuss
 * opens a thread to talk it through first.
 */
export function MobileDecisions({
  summary,
  onOpenThread,
}: {
  readonly summary: OrchestratorSummary;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const query = useEnvironmentQuery(
    mobileProjectIssues({
      environmentId: summary.root.environmentId,
      input: { rootThreadId: summary.root.id },
    }),
  );
  const decide = useAtomCommand(mobileDecideProjectRequest, "Decide");
  const discuss = useAtomCommand(mobileDiscussProjectRequest, "Discuss");
  const [discussing, setDiscussing] = useState<string | null>(null);
  const startDiscussion = async (issue: ProjectIssue) => {
    if (discussing !== null) return;
    setDiscussing(issueKey(issue));
    try {
      const result = await discuss({
        environmentId: summary.root.environmentId,
        input: { threadId: summary.root.id, reference: issueKey(issue) },
      });
      if (result._tag === "Success") onOpenThread(result.value.threadId);
    } finally {
      setDiscussing(null);
    }
  };
  const [answers, setAnswers] = useState<ReadonlyMap<string, DecisionAnswerRecord<ProjectIssue>>>(
    new Map(),
  );
  const waiting = useMemo(
    () =>
      (query.data?.issues ?? []).filter(
        (issue) => issue.decision !== undefined && issue.closedAt === null,
      ),
    [query.data],
  );
  const live = useMemo(() => new Set(waiting.map(issueKey)), [waiting]);
  const readAt = query.dataUpdatedAt ?? 0;
  // Answers whose card has left are forgotten on each new list read, so a question
  // asked again shows its options.
  const [prunedAt, setPrunedAt] = useState(readAt);
  if (prunedAt !== readAt) {
    setPrunedAt(readAt);
    setAnswers((current) => keptDecisionAnswers(current, live, readAt));
  }
  const kept = keptDecisionAnswers(answers, live, readAt);
  const record = (key: string, entry: DecisionAnswerRecord<ProjectIssue> | null) =>
    setAnswers((current) => {
      const next = new Map(current);
      if (entry) next.set(key, entry);
      else next.delete(key);
      return next;
    });
  const send = async (entry: Omit<DecisionAnswerRecord<ProjectIssue>, "delivery">) => {
    const key = issueKey(entry.issue);
    record(key, { ...entry, delivery: { phase: "sending" } });
    const result = await decide({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id, reference: key, ...entry.input },
    });
    query.refresh();
    const error = result._tag === "Success" ? null : squashAtomCommandFailure(result);
    record(key, {
      ...entry,
      delivery:
        result._tag === "Success"
          ? sentDelivery(result.value.notifiedThreadId !== null)
          : {
              phase: "failed",
              error:
                error instanceof Error && error.message
                  ? error.message
                  : "Could not reach the server.",
            },
    });
  };
  const decisions = [
    ...waiting,
    ...[...kept].filter(([key]) => !live.has(key)).map(([, entry]) => entry.issue),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (decisions.length === 0) return null;
  return (
    <View className="mt-2 gap-2">
      <Text className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
        Decisions {decisions.length}
      </Text>
      {decisions.map((issue) => {
        const answer = kept.get(issueKey(issue)) ?? null;
        return (
          <DecisionCard
            key={issueKey(issue)}
            environmentId={summary.root.environmentId}
            issue={issue}
            waiting={waitingLabel(issue.decision!.waiting, [summary.root, ...summary.descendants])}
            answer={answer}
            onSend={(answered, input) => void send({ issue, answered, input })}
            onRetry={() => answer && void send(answer)}
            onDrop={() => record(issueKey(issue), null)}
            discussing={discussing === issueKey(issue)}
            onDiscuss={() => void startDiscussion(issue)}
          />
        );
      })}
    </View>
  );
}
