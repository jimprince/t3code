import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { mobileDecideProjectRequest, mobileProjectIssues } from "../../state/projectRequests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const MAX_NOTE = 500;

function DecisionCard({
  issue,
  onSend,
}: {
  readonly issue: ProjectIssue;
  readonly onSend: (pick: { option: string } | { answer: string }, note: string) => Promise<void>;
}) {
  const decision = issue.decision!;
  const open = decision.options.length === 0;
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const answer = open ? text.trim() : (selected ?? "");
  const send = async () => {
    if (!answer || sending) return;
    setSending(true);
    await onSend(open ? { answer } : { option: answer }, note.trim());
    setSending(false);
  };
  return (
    <View className="gap-1 border-t border-border pt-2">
      <Text className="text-sm text-foreground">{issue.title}</Text>
      {decision.context ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={4}>
          {decision.context}
        </Text>
      ) : null}
      {open ? (
        <TextInput
          accessibilityLabel="Answer"
          value={text}
          onChangeText={setText}
          placeholder="Answer"
          placeholderTextColorClassName="accent-placeholder"
          maxLength={2000}
          className="rounded-md border border-border px-2 py-1 text-sm font-sans text-foreground"
        />
      ) : (
        decision.options.map((option) => (
          <Pressable
            key={option.text}
            accessibilityRole="button"
            accessibilityState={{ selected: selected === option.text }}
            onPress={() => setSelected(option.text)}
            className={`rounded-md border px-2 py-1.5 ${selected === option.text ? "border-foreground" : "border-border"}`}
          >
            <Text className="text-sm text-foreground">
              {option.text}
              {option.recommended ? "  (recommended)" : ""}
            </Text>
          </Pressable>
        ))
      )}
      <TextInput
        accessibilityLabel="Note"
        value={note}
        onChangeText={setNote}
        placeholder="Note (optional)"
        placeholderTextColorClassName="accent-placeholder"
        maxLength={MAX_NOTE}
        className="rounded-md border border-border px-2 py-1 text-sm font-sans text-foreground"
      />
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          disabled={!answer || sending}
          onPress={() => void send()}
          className={`rounded-md border border-foreground px-3 py-1.5 ${!answer || sending ? "opacity-40" : ""}`}
        >
          <Text className="text-sm text-foreground">{sending ? "Sending" : "Send"}</Text>
        </Pressable>
        <Text className="flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {decision.waiting} · #{issue.number}
        </Text>
      </View>
    </View>
  );
}

/**
 * Decisions waiting on Brad (open needs-brad issues) under a project: pick an
 * option or type an answer, add an optional note and send. The answer is commented
 * on the issue and sent to the waiting thread.
 */
export function MobileDecisions({ summary }: { readonly summary: OrchestratorSummary }) {
  const query = useEnvironmentQuery(
    mobileProjectIssues({
      environmentId: summary.root.environmentId,
      input: { rootThreadId: summary.root.id },
    }),
  );
  const decide = useAtomCommand(mobileDecideProjectRequest, "Decide");
  const decisions = (query.data?.issues ?? [])
    .filter((issue) => issue.decision !== undefined && issue.closedAt === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (decisions.length === 0) return null;
  return (
    <View className="mt-2 gap-2">
      <Text className="text-xs text-foreground-muted">{decisions.length} decisions waiting</Text>
      {decisions.map((issue) => (
        <DecisionCard
          key={`${issue.repository}#${issue.number}`}
          issue={issue}
          onSend={async (pick, note) => {
            await decide({
              environmentId: summary.root.environmentId,
              input: {
                threadId: summary.root.id,
                reference: `${issue.repository}#${issue.number}`,
                decision: "option" in pick ? "option" : "answer",
                ...pick,
                ...(note ? { reason: note } : {}),
              },
            });
            query.refresh();
          }}
        />
      ))}
    </View>
  );
}
