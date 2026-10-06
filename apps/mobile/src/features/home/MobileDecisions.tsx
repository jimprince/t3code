import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  decisionAnswerInput,
  decisionSendStrip,
  type DecisionAnswerInput,
  type DecisionPick,
} from "@t3tools/client-runtime/decision-answer";
import type { ProjectIssue } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { mobileDecideProjectRequest, mobileProjectIssues } from "../../state/projectRequests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const MAX_NOTE = 500;
const SENT_LINGER_MS = 1500;

const issueKey = (issue: ProjectIssue) => `${issue.repository}#${issue.number}`;

type Selection = { readonly kind: "option"; readonly option: string } | { readonly kind: "other" };

function DecisionCard({
  issue,
  sent,
  onSend,
}: {
  readonly issue: ProjectIssue;
  readonly sent: boolean;
  readonly onSend: (input: DecisionAnswerInput) => Promise<boolean>;
}) {
  const decision = issue.decision!;
  const open = decision.options.length === 0;
  const [selected, setSelected] = useState<Selection | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const pick: DecisionPick | null = open
    ? { kind: "open", text }
    : selected?.kind === "option"
      ? { kind: "option", option: selected.option }
      : selected?.kind === "other"
        ? { kind: "other", text }
        : null;
  const input = pick ? decisionAnswerInput(pick, note) : null;
  const send = async () => {
    if (!input || sending) return;
    setSending(true);
    await onSend(input);
    setSending(false);
  };
  const showText = open || selected?.kind === "other";
  return (
    <View className="gap-1 border-t border-border pt-2">
      <Text className="text-sm text-foreground">{issue.title}</Text>
      {decision.context ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={4}>
          {decision.context}
        </Text>
      ) : null}
      {sent ? (
        <Text className="text-sm text-foreground">
          {decisionSendStrip("sent", decision.waiting).text}
        </Text>
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
                    className={`rounded-md border px-2 py-1.5 ${active ? "border-foreground" : "border-border"}`}
                  >
                    <Text className="text-sm text-foreground">
                      {option.text}
                      {option.recommended ? "  (recommended)" : ""}
                    </Text>
                  </Pressable>
                );
              })}
          {open ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: selected?.kind === "other" }}
              onPress={() => setSelected({ kind: "other" })}
              className={`rounded-md border px-2 py-1.5 ${selected?.kind === "other" ? "border-foreground" : "border-border"}`}
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
              className="rounded-md border border-border px-2 py-1 text-sm font-sans text-foreground"
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
              className="rounded-md border border-border px-2 py-1 text-sm font-sans text-foreground"
            />
          ) : null}
          <View className="flex-row items-center gap-3">
            <Pressable
              accessibilityRole="button"
              disabled={!input || sending}
              onPress={() => void send()}
              className={`rounded-md border border-foreground px-3 py-1.5 ${!input || sending ? "opacity-40" : ""}`}
            >
              <Text className="text-sm text-foreground">{sending ? "Sending" : "Send"}</Text>
            </Pressable>
            {noteOpen ? null : (
              <Pressable accessibilityRole="button" onPress={() => setNoteOpen(true)}>
                <Text className="text-xs text-foreground-muted">Add note</Text>
              </Pressable>
            )}
            <Text className="flex-1 text-xs text-foreground-muted" numberOfLines={1}>
              {decision.waiting} · #{issue.number}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

/**
 * Decisions waiting on Brad (open needs-brad issues) under a project: pick an
 * option, Other... or type an answer, optionally add a note, and Send. The answer is
 * commented on the issue and sent to the waiting thread; the card reads Sent before
 * it leaves.
 */
export function MobileDecisions({ summary }: { readonly summary: OrchestratorSummary }) {
  const query = useEnvironmentQuery(
    mobileProjectIssues({
      environmentId: summary.root.environmentId,
      input: { rootThreadId: summary.root.id },
    }),
  );
  const decide = useAtomCommand(mobileDecideProjectRequest, "Decide");
  const [sent, setSent] = useState<ReadonlyMap<string, ProjectIssue>>(new Map());
  const waiting = (query.data?.issues ?? []).filter(
    (issue) => issue.decision !== undefined && issue.closedAt === null,
  );
  const live = new Set(waiting.map(issueKey));
  const decisions = [
    ...waiting,
    ...[...sent.values()].filter((issue) => !live.has(issueKey(issue))),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (decisions.length === 0) return null;
  return (
    <View className="mt-2 gap-2">
      <Text className="text-xs text-foreground-muted">{decisions.length} decisions waiting</Text>
      {decisions.map((issue) => (
        <DecisionCard
          key={issueKey(issue)}
          issue={issue}
          sent={sent.has(issueKey(issue))}
          onSend={async (input) => {
            const result = await decide({
              environmentId: summary.root.environmentId,
              input: {
                threadId: summary.root.id,
                reference: issueKey(issue),
                ...input,
              },
            });
            if (result._tag !== "Success") return false;
            setSent((current) => new Map(current).set(issueKey(issue), issue));
            query.refresh();
            setTimeout(
              () =>
                setSent((current) => {
                  const next = new Map(current);
                  next.delete(issueKey(issue));
                  return next;
                }),
              SENT_LINGER_MS,
            );
            return true;
          }}
        />
      ))}
    </View>
  );
}
