import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { MessageId, ProjectRequestStartIntakeResult } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent,
} from "react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { startRequestIntake, submitProjectRequest } from "../../state/projectIssues";
import { saveRequestForLater } from "../../state/projectRoadmap";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "../chat/composerPromptHistory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { sentRequestStatus } from "./projectRequests.logic";
import { useProjectRequests } from "./ProjectRequestsSection";
import { attemptKey, failureReason, sendRequest, type SendAttempt } from "./sendOutcome.logic";
import { useSendToOrchestrator, useSendToThread } from "./sendToOrchestrator";
import { TaskTitle } from "./TaskLink";

type IntakeThread = ProjectRequestStartIntakeResult;

/** How long the sent line stays, and when to look again for the filed request. */
const SENT_LINE_MS = 120_000;
const FILING_CHECKS_MS = [3_000, 10_000, 30_000, 60_000];

function imageAttachment(file: File): ComposerImageAttachment {
  return {
    type: "image",
    id: randomUUID(),
    name: file.name || "pasted-image.png",
    mimeType: file.type || "image/png",
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

const imageFiles = (files: FileList | null | undefined) =>
  [...(files ?? [])].filter((file) => file.type.startsWith("image/"));

/** A request Brad starts often: the chip's label and the text it puts in the box. */
export interface RequestQuickAction {
  readonly label: string;
  readonly text: string;
}

/** The Dashboard's starters, from the requests Brad sends agents most. */
export const REQUEST_QUICK_ACTIONS: ReadonlyArray<RequestQuickAction> = [
  { label: "Bug report", text: "Bug: " },
  { label: "Feature request", text: "Feature: " },
  { label: "Have an agent…", text: "Have an agent " },
  { label: "Speed up…", text: "Speed up " },
  { label: "Check every…", text: "Every 30 minutes, check " },
  { label: "Update dashboard", text: "Update the dashboard." },
  { label: "Clean up threads", text: "Settle finished threads and tidy this project." },
];

/**
 * The project page's New request box, first on every tab. Send
 * files a new request and gives the text (and pasted or dropped images) verbatim
 * to the project's intake thread, or its orchestrator, in the background,
 * through the normal send path where the request ledger captures it, and says
 * which request tracks it once filed. Save for later files it straight into the
 * roadmap's Later column without waking the orchestrator. One line until focused, when the
 * composer and the quick actions open; it folds back after sending, and when it loses focus
 * empty. Text that was typed keeps it open.
 */
export function ProjectRequestBox({
  summary,
  quickActions,
  prefill,
  placeholder = "New request",
}: {
  readonly summary: OrchestratorSummary;
  /** Chips under the closed box that start a request with their text. */
  readonly quickActions?: ReadonlyArray<RequestQuickAction> | undefined;
  /** Opens the box with this text, such as an Unstick message; each new nonce applies once. */
  readonly prefill?: { readonly text: string; readonly nonce: number } | null | undefined;
  /** The empty box's hint, such as who the request goes to; the accessible name stays "New request". */
  readonly placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  // Set by a quick action or a prefill so the caret lands after the text it puts in the box.
  const caretToEnd = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const submit = useAtomCommand(submitProjectRequest, { reportFailure: false });
  const startIntake = useAtomCommand(startRequestIntake, { reportFailure: false });
  const archiveThread = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  // A failed send has already filed the request under its message id (and may have started an
  // intake thread); a retry of the same text reuses both, so nothing is filed twice.
  const failedAttempt = useRef<SendAttempt<IntakeThread> | null>(null);
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [sent, setSent] = useState<{
    messageId: MessageId;
    queued: boolean;
    /** Triaged by an intake thread rather than sent to the orchestrator. */
    intake: boolean;
  } | null>(null);
  const saveForLater = useAtomCommand(saveRequestForLater, "Save for later");
  const sendToOrchestrator = useSendToOrchestrator();
  const sendToThread = useSendToThread();
  const statusTimer = useRef<number | null>(null);
  const sentTimers = useRef<number[]>([]);
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  const environmentId = summary.root.environmentId;
  const abandonRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    abandonRef.current = () => {
      const attempt = failedAttempt.current;
      failedAttempt.current = null;
      if (attempt?.intake) {
        void archiveThread({ environmentId, input: { threadId: attempt.intake.threadId } });
      }
    };
  });
  // Clearing the box, or leaving the page, abandons a failed request: its intake thread goes.
  const cleared = text.length === 0 && images.length === 0;
  useEffect(() => {
    if (cleared && !sending.current) abandonRef.current();
  }, [cleared]);

  // Previews are object URLs; release them when the box goes away.
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
      abandonRef.current();
      if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
      for (const timer of sentTimers.current) window.clearTimeout(timer);
    },
    [],
  );

  const flash = (message: string) => {
    setStatus(message);
    if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), 3_000);
  };
  const addImages = (files: File[]) => {
    if (files.length > 0 && !sending.current)
      setImages((current) => [...current, ...files.map(imageAttachment)]);
  };
  const reset = () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    setText("");
    setImages([]);
  };
  const open = expanded || text.length > 0 || images.length > 0;
  // Runs after every commit but acts only while the flag is set: it puts the caret after the new
  // text once the composer shows it, then clears the flag so it cannot pull the caret to the end
  // on a later focus.
  useLayoutEffect(() => {
    const field = boxRef.current?.querySelector("textarea");
    if (!caretToEnd.current || !field) return;
    caretToEnd.current = false;
    field.setSelectionRange(field.value.length, field.value.length);
  });
  const appliedPrefill = useRef(prefill?.nonce ?? 0);
  useEffect(() => {
    if (!prefill || prefill.nonce === appliedPrefill.current) return;
    appliedPrefill.current = prefill.nonce;
    caretToEnd.current = true;
    setText(prefill.text);
    setExpanded(true);
  }, [prefill]);

  const send = async () => {
    if ((!text.trim() && images.length === 0) || sending.current) return;
    const prompt = text;
    const attached = images;
    const key = attemptKey(
      prompt,
      attached.map((image) => image.id),
    );
    if (failedAttempt.current && failedAttempt.current.key !== key) abandonRef.current();
    const previous = failedAttempt.current;
    // Image-only requests still need a message body, as in the chat composer.
    const messageText = prompt.trim() ? prompt : ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;
    sending.current = true;
    setBusy(true);
    setSent(null);
    setStatus("Sending...");
    // The text and images stay in the box until the server has taken the message, so
    // a failed send loses nothing. A short-lived intake thread triages the request
    // (type, title, roadmap, and then answer, catalog, start a worker or hand it
    // on), so the orchestrator is not woken for every request.
    let result: Awaited<ReturnType<typeof sendRequest<IntakeThread>>>;
    try {
      result = await sendRequest<IntakeThread>({
        key,
        previous,
        startIntake: () =>
          startIntake({
            environmentId,
            input: { threadId: summary.root.id, title: prompt.trim() || "Request with images" },
          }),
        // The request is marked explicit before its message is sent, so the ledger
        // files it as a new task instead of folding it into an existing one.
        sendToIntake: (intake, messageId) =>
          sendToThread(
            { environmentId, threadId: intake.threadId },
            {
              modelSelection: intake.modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
            `${intake.brief}\n\n${messageText}`,
            attached,
            {
              ...(messageId ? { messageId } : {}),
              beforeSend: (messageId) =>
                submit({
                  environmentId,
                  input: { threadId: intake.threadId, messageId, text: messageText },
                }),
            },
          ),
        // A server without intake threads: the orchestrator gets it, as before.
        sendToOrchestrator: (messageId) =>
          sendToOrchestrator(
            summary,
            messageText,
            attached,
            (id) =>
              submit({
                environmentId,
                input: { threadId: summary.root.id, messageId: id, text: messageText },
              }),
            messageId,
          ),
      });
    } catch (error) {
      // Nothing was filed or sent: the intake thread could not even be started.
      setStatus(`Not sent: ${failureReason(error)}`);
      setExpanded(true);
      return;
    } finally {
      sending.current = false;
      setBusy(false);
    }
    if (!result.ok) {
      failedAttempt.current = result.attempt;
      setStatus(`Not sent: ${result.reason}`);
      setExpanded(true);
      return;
    }
    failedAttempt.current = null;
    reset();
    setExpanded(false);
    setStatus(null);
    setSent({ messageId: result.messageId, queued: result.queued, intake: result.intake });
    // The sent line looks the filed request up itself; let the line go after a while.
    for (const timer of sentTimers.current) window.clearTimeout(timer);
    sentTimers.current = [window.setTimeout(() => setSent(null), SENT_LINE_MS)];
  };

  const saveLater = async () => {
    const detail = text.trim();
    if (!detail) return;
    const title = detail.split("\n")[0]!.slice(0, 200);
    const result = await saveForLater({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id, title, kind: "task", detail, park: true },
    });
    if (result._tag === "Success") {
      reset();
      flash("Saved for later");
    }
  };

  return (
    <div
      ref={boxRef}
      className="flex flex-col gap-2"
      // Fold only when focus leaves the whole box, so Tab can reach the quick actions and buttons.
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (event.target instanceof HTMLInputElement) return;
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setExpanded(false);
      }}
      onDragOver={(event: DragEvent) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event: DragEvent) => {
        const files = imageFiles(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        addImages(files);
      }}
    >
      {open ? null : (
        // One line until used; focusing it opens the composer in its place.
        <Input
          aria-label="New request"
          size="compact"
          value=""
          readOnly
          placeholder={placeholder}
          onFocus={() => setExpanded(true)}
          onPaste={(event: ClipboardEvent) => {
            const files = imageFiles(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            addImages(files);
          }}
        />
      )}
      {open ? (
        <Textarea
          aria-label="New request"
          value={text}
          rows={3}
          disabled={busy}
          autoFocus
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event: ClipboardEvent) => {
            const files = imageFiles(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            addImages(files);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
              event.currentTarget.blur();
            } else if (event.key === "Escape" && !text && images.length === 0) {
              event.currentTarget.blur();
            }
          }}
        />
      ) : null}
      {open && cleared && quickActions && quickActions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {quickActions.map((action) => (
            <Button
              key={action.label}
              size="xs"
              variant="outline"
              // Keep the composer focused: a blur here would fold it before the click lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                caretToEnd.current = true;
                setText(action.text);
                setExpanded(true);
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
      {images.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {images.map((image) => (
            <li key={image.id} className="relative">
              <img
                src={image.previewUrl}
                alt={image.name}
                className="size-14 rounded-sm border border-border object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                disabled={busy}
                className="absolute -top-1.5 -right-1.5 rounded-full bg-background p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  URL.revokeObjectURL(image.previewUrl);
                  setImages((current) => current.filter((item) => item.id !== image.id));
                }}
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open || status || sent ? (
        <div className="flex items-center gap-2">
          {open ? (
            <>
              {/* Keep the box open while a button takes the click. */}
              <Button
                size="xs"
                disabled={busy || (!text.trim() && images.length === 0)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void send()}
              >
                Send
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !text.trim() || images.length > 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void saveLater()}
              >
                Save for later
              </Button>
            </>
          ) : null}
          <span role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {status ?? (sent ? <SentLine summary={summary} messageId={sent.messageId} /> : null)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Sent · <the filed task's title>", which opens the task; the title once it is filed.
 * The project's issue list is read here, once a request has been sent, rather than when the
 * box mounts: the Dashboard shows the box on every visit and the read can be slow. The ledger
 * files the request a few seconds after the send, so the list is read again for a minute.
 */
function SentLine({
  summary,
  messageId,
}: {
  readonly summary: OrchestratorSummary;
  readonly messageId: MessageId;
}) {
  const { query, pending } = useProjectRequests(summary);
  const refresh = useRef(query.refresh);
  useEffect(() => {
    refresh.current = query.refresh;
  });
  useEffect(() => {
    const timers = FILING_CHECKS_MS.map((delay) =>
      window.setTimeout(() => refresh.current(), delay),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);
  const status = sentRequestStatus(messageId, query.data?.issues ?? [], pending);
  if (status.state !== "tracked") return <>Sent</>;
  return (
    <>
      Sent ·{" "}
      {status.issues.map((issue, index) => (
        <span key={issue.url}>
          {index > 0 ? ", " : ""}
          <TaskTitle
            task={{ host: issue.host, repository: issue.repository, number: issue.number }}
            url={issue.url}
            className="text-foreground/90 hover:underline"
          >
            {issue.title}
          </TaskTitle>
        </span>
      ))}
    </>
  );
}
