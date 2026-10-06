import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type EmbeddedPage,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  HistoryIcon,
  SendHorizontalIcon,
  SquareIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { selectChatProjectForEnvironment } from "~/projectKind";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadVisibleTurnItems,
} from "~/state/entities";
import { EMPTY_SERVER_PROVIDERS } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildPageAgentPreamble,
  deletePageAgentConversation,
  newPageAgentConversation,
  isPageAgentRunning,
  openPageAgentConversation,
  pageAgentActivityLabel,
  pageAgentModelSelection,
  resolvePageAgentModelSelection,
  resumePreviousPageAgentConversation,
  stripPageAgentPreamble,
  type PageAgentConversations,
} from "./pageAgent.logic";
import { newPageAgentThreadId, useRememberedPageAgentModel } from "./usePageAgent";

/**
 * The right-hand tray beside an embedded page: a conversation with an agent
 * that operates the page (desktop) and reaches T3 threads through the
 * `t3-thread` CLI. Closing the tray or leaving the page stops a running turn,
 * so the agent only acts on the page while the tray is in view.
 */
export function PageAgentTray(props: {
  readonly page: EmbeddedPage;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly conversations: PageAgentConversations;
  readonly onConversationsChange: (next: PageAgentConversations) => void;
  /** Queues a conversation for permanent deletion once it has no turn running. */
  readonly onDiscard: (threadId: string | null) => void;
  /** False where the page cannot be driven (a browser frame on web). */
  readonly pageActionsAvailable: boolean;
  readonly onClose: () => void;
}) {
  const { page, environmentId, threadRef, conversations, onConversationsChange } = props;
  const exists = conversations.lastSentAt !== null;
  const detail = useThreadProjection(exists ? threadRef : null);
  const thread = detail?.projection ?? null;
  const visibleItems = useThreadVisibleTurnItems(exists ? threadRef : null);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "page agent send");
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const chatProject = selectChatProjectForEnvironment(useProjects(), environmentId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const model = usePageAgentModel(environmentId, thread?.thread.modelSelection ?? null);

  const discard = props.onDiscard;

  // Opening the tray continues a recent conversation and otherwise starts fresh.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    const change = openPageAgentConversation({
      stored: conversations,
      now: Date.now(),
      newId: newPageAgentThreadId(page.id),
    });
    if (change === null) return;
    onConversationsChange(change.conversations);
    discard(change.discarded);
  });

  const running = sending || (thread !== null && isPageAgentRunning(thread));
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  const interrupt = () => {
    void interruptTurn({ environmentId, input: { threadId: threadRef.threadId } });
  };
  useEffect(
    () => () => {
      if (runningRef.current) {
        void interruptTurn({ environmentId, input: { threadId: threadRef.threadId } });
      }
    },
    [environmentId, interruptTurn, threadRef.threadId],
  );

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || running || model.selection === null) return;
    if (!exists && chatProject === null) return;
    setSending(true);
    const createdAt = new Date().toISOString();
    const result = await startTurn({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        message: {
          messageId: MessageId.make(randomUUID()),
          role: "user",
          text: exists ? text : `${buildPageAgentPreamble(page)}${text}`,
          attachments: [],
        },
        modelSelection: model.selection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
        ...(exists || chatProject === null
          ? {}
          : {
              bootstrap: {
                createThread: {
                  projectId: chatProject.id,
                  title: `${page.name} agent`,
                  modelSelection: model.selection,
                  runtimeMode: DEFAULT_RUNTIME_MODE,
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
              },
            }),
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setDraft("");
      onConversationsChange({ ...conversations, lastSentAt: createdAt });
    }
  };

  const startNew = () => {
    const change = newPageAgentConversation(conversations, newPageAgentThreadId(page.id));
    onConversationsChange(change.conversations);
    discard(change.discarded);
  };
  const resumePrevious = () => {
    const next = resumePreviousPageAgentConversation(conversations, new Date().toISOString());
    if (next !== null) onConversationsChange(next);
  };
  const deleteCurrent = () => {
    onConversationsChange(
      deletePageAgentConversation(
        conversations,
        newPageAgentThreadId(page.id),
        new Date().toISOString(),
      ),
    );
    discard(exists ? conversations.current : null);
  };

  const messages = thread?.messages ?? [];
  const activity = running ? pageAgentActivityLabel(visibleItems) : null;
  const sessionError = thread?.providerSessions.at(-1)?.lastError ?? null;

  return (
    <aside className="flex w-[400px] min-w-0 shrink-0 flex-col border-l bg-background">
      <div className="flex h-11 items-center gap-1 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{page.name} agent</span>
        <TrayAction
          label={
            conversations.previous === null
              ? "New conversation"
              : "New conversation (permanently deletes the oldest one)"
          }
          onClick={startNew}
          disabled={!exists}
        >
          <SquarePenIcon />
        </TrayAction>
        <TrayAction
          label="Resume previous conversation"
          onClick={resumePrevious}
          disabled={conversations.previous === null}
        >
          <HistoryIcon />
        </TrayAction>
        <TrayAction
          label={running ? "Stop the agent before deleting" : "Delete conversation permanently"}
          onClick={deleteCurrent}
          disabled={!exists || running}
        >
          <Trash2Icon />
        </TrayAction>
        <TrayAction label="Close" onClick={props.onClose}>
          <XIcon />
        </TrayAction>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="space-y-2 text-sm">
            <p>
              {props.pageActionsAvailable
                ? `Ask the agent to work in ${page.name}, or to check on your threads.`
                : `Page actions need the desktop app. Here the agent can still read and message your threads.`}
            </p>
            {conversations.previous !== null ? (
              <Button size="xs" variant="outline" onClick={resumePrevious}>
                <HistoryIcon />
                Resume previous conversation
              </Button>
            ) : null}
          </div>
        ) : (
          messages.map((message) => (
            <TrayMessage key={message.id} message={message} environmentId={environmentId} />
          ))
        )}
        {running ? <p className="truncate text-xs">{activity ?? "Working…"}</p> : null}
        {sessionError !== null && !running ? (
          <p className="text-xs text-destructive-foreground">{sessionError}</p>
        ) : null}
      </div>
      <div className="space-y-2 border-t p-3">
        <Textarea
          size="sm"
          value={draft}
          placeholder={`Message the ${page.name} agent`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{model.picker}</div>
          {running ? (
            <Button size="sm" variant="outline" onClick={interrupt}>
              <SquareIcon />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void send()}
              disabled={draft.trim().length === 0 || model.selection === null}
            >
              <SendHorizontalIcon />
              Send
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

function TrayAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const TrayMessage = memo(function TrayMessage(props: {
  readonly message: OrchestrationV2ConversationMessage;
  readonly environmentId: EnvironmentId;
}) {
  const { message } = props;
  if (message.role === "user") {
    return (
      <div className="self-end whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-sm">
        {stripPageAgentPreamble(message.text)}
      </div>
    );
  }
  if (message.role !== "assistant" || message.text.length === 0) return null;
  return (
    <ChatMarkdown
      text={message.text}
      cwd={undefined}
      environmentId={props.environmentId}
      isStreaming={message.streaming}
      className="text-sm"
    />
  );
});

/**
 * The tray's model and its picker. A conversation keeps the model it was sent
 * with until the user picks another; a pick is remembered for future trays.
 */
function usePageAgentModel(environmentId: EnvironmentId, threadModel: ModelSelection | null) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useServerConfigs().get(environmentId)?.providers ?? EMPTY_SERVER_PROVIDERS;
  const [remembered, setRemembered] = useRememberedPageAgentModel();
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const selection =
    picked ??
    threadModel ??
    resolvePageAgentModelSelection({
      remembered,
      entries,
      fallback: resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection),
    });
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const picker =
    selection === null ? (
      <span className="text-xs">No providers available</span>
    ) : (
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        size="sm"
        onInstanceModelChange={(instanceId, model) => {
          const next = pageAgentModelSelection(instanceId, model);
          setPicked(next);
          setRemembered(next);
        }}
      />
    );
  return { selection, picker };
}
