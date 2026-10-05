import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MessageId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { startRequestIntake, submitProjectRequest } from "../../state/projectIssues";
import { saveRequestForLater } from "../../state/projectRoadmap";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { sentRequestStatus } from "./projectRequests.logic";
import { useProjectRequests } from "./ProjectRequestsSection";
import { sendToOrchestrator, sendToThread } from "./sendToOrchestrator";

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

/**
 * The project page's New request box, above the tabs so every tab has it: a
 * support box where the work actually gets done; it files a new request. Send gives the text (and pasted or
 * dropped images) verbatim to the project's orchestrator in the background,
 * through the normal send path where the request ledger captures it, and says
 * which request tracks it once filed. Save for later files it straight into the
 * roadmap's Later column without waking the orchestrator. One line until focused;
 * it folds back after sending, or on Escape when empty.
 */
export function ProjectRequestBox({ summary }: { readonly summary: OrchestratorSummary }) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const submit = useAtomCommand(submitProjectRequest, { reportFailure: false });
  const startIntake = useAtomCommand(startRequestIntake, { reportFailure: false });
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [sent, setSent] = useState<{
    messageId: MessageId;
    queued: boolean;
    /** Triaged by an intake thread rather than sent to the orchestrator. */
    intake: boolean;
  } | null>(null);
  const saveForLater = useAtomCommand(saveRequestForLater, "Save for later");
  const { query, pending } = useProjectRequests(summary);
  const sentStatus = useMemo(
    () => (sent ? sentRequestStatus(sent.messageId, query.data?.issues ?? [], pending) : null),
    [pending, query.data, sent],
  );
  const statusTimer = useRef<number | null>(null);
  const sentTimers = useRef<number[]>([]);
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  // Previews are object URLs; release them when the box goes away.
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
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
    if (files.length > 0) setImages((current) => [...current, ...files.map(imageAttachment)]);
  };
  const reset = () => {
    setText("");
    setImages([]);
  };
  const open = expanded || text.length > 0 || images.length > 0;

  const send = async () => {
    if (!text.trim() && images.length === 0) return;
    const prompt = text;
    const attached = images;
    const environmentId = summary.root.environmentId;
    reset();
    setExpanded(false);
    setStatus("Starting triage...");
    // A short-lived intake thread triages the request (type, title, roadmap, and
    // then answer, catalog, start a worker or hand it on), so the orchestrator is
    // not woken for every request.
    const intake = await startIntake({
      environmentId,
      input: { threadId: summary.root.id, title: prompt.trim() || "Request with images" },
    });
    // The request is marked explicit before its message is sent, so the ledger
    // files it as a new task instead of folding it into an existing one.
    const result =
      intake._tag === "Success"
        ? sendToThread(
            scopeThreadRef(environmentId, intake.value.threadId),
            {
              modelSelection: intake.value.modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
            `${intake.value.brief}\n\n${prompt}`,
            attached,
            {
              beforeSend: (messageId) =>
                submit({
                  environmentId,
                  input: { threadId: intake.value.threadId, messageId, text: prompt },
                }),
            },
          )
        : // A server without intake threads: the orchestrator gets it, as before.
          sendToOrchestrator(summary, prompt, attached, (messageId) =>
            submit({
              environmentId,
              input: { threadId: summary.root.id, messageId, text: prompt },
            }),
          );
    setStatus(null);
    setSent({ ...result, intake: intake._tag === "Success" });
    // The ledger files the request a few seconds after the send; look for it, then
    // let the line go.
    for (const timer of sentTimers.current) window.clearTimeout(timer);
    sentTimers.current = [
      ...FILING_CHECKS_MS.map((delay) => window.setTimeout(query.refresh, delay)),
      window.setTimeout(() => setSent(null), SENT_LINE_MS),
    ];
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
      flash(result.value.queued ? "Saved; filing when Gitea is back" : "Saved for later");
    }
  };

  return (
    <div
      className="flex flex-col gap-2"
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
          value=""
          readOnly
          placeholder="New request: ask the orchestrator, or save an idea for later"
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
          autoFocus
          placeholder="New request: ask the orchestrator, or save an idea for later"
          onBlur={() => setExpanded(false)}
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
                disabled={!text.trim() && images.length === 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void send()}
              >
                Send
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!text.trim() || images.length > 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void saveLater()}
              >
                Save for later
              </Button>
            </>
          ) : null}
          <span role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {status ??
              (sent && sentStatus ? (
                <SentLine queued={sent.queued} intake={sent.intake} status={sentStatus} />
              ) : null)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** "Sent to the orchestrator · tracked as request #N", or why there is no link yet. */
function SentLine({
  queued,
  intake,
  status,
}: {
  readonly queued: boolean;
  readonly intake: boolean;
  readonly status: ReturnType<typeof sentRequestStatus>;
}) {
  const lead = intake
    ? "Sent for triage"
    : queued
      ? "Queued for the orchestrator"
      : "Sent to the orchestrator";
  if (status.state === "pending") return <>{lead} · pending filing</>;
  if (status.state === "filing") return <>{lead}</>;
  return (
    <>
      {lead} · tracked as{" "}
      {status.issues.map((issue, index) => (
        <span key={issue.url}>
          {index > 0 ? ", " : ""}
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground/90 hover:underline"
          >
            request #{issue.number}
          </a>
        </span>
      ))}
    </>
  );
}
