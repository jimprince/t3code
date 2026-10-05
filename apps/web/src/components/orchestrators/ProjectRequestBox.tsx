import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { MessageId } from "@t3tools/contracts";
import { ArrowUpRightIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { saveRequestForLater } from "../../state/projectRoadmap";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { sentRequestStatus } from "./projectRequests.logic";
import { useProjectRequests } from "./ProjectRequestsSection";
import { sendToOrchestrator } from "./sendToOrchestrator";

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
 * The project page's request box, pinned at the top of the Dashboard: a support
 * box where the work actually gets done. Send gives the text (and pasted or
 * dropped images) verbatim to the project's orchestrator in the background,
 * through the normal send path where the request ledger captures it, and says
 * which request tracks it once filed. Save for later files it straight into the
 * roadmap's Later column without waking the orchestrator. Open chat is explicit.
 */
export function ProjectRequestBox({
  summary,
  onOpenChat,
}: {
  readonly summary: OrchestratorSummary;
  readonly onOpenChat: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [sent, setSent] = useState<{ messageId: MessageId; queued: boolean } | null>(null);
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

  const send = () => {
    if (!text.trim() && images.length === 0) return;
    const result = sendToOrchestrator(summary, text, images);
    reset();
    setStatus(null);
    setSent(result);
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
      input: { threadId: summary.root.id, title, kind: "change", detail, park: true },
    });
    if (result._tag === "Success") {
      reset();
      flash(result.value.queued ? "Saved; filing when Gitea is back" : "Saved for later");
    }
  };

  return (
    <div
      className="mb-3 flex flex-col gap-2"
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
      <Textarea
        aria-label="New request"
        value={text}
        rows={2}
        placeholder="Ask the orchestrator, or save an idea for later"
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
            send();
          }
        }}
      />
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
      <div className="flex items-center gap-2">
        <Button size="xs" disabled={!text.trim() && images.length === 0} onClick={send}>
          Send
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!text.trim() || images.length > 0}
          onClick={() => void saveLater()}
        >
          Save for later
        </Button>
        <span role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {status ??
            (sent && sentStatus ? <SentLine queued={sent.queued} status={sentStatus} /> : null)}
        </span>
        <Button size="xs" variant="ghost-muted" onClick={onOpenChat}>
          Open chat
          <ArrowUpRightIcon />
        </Button>
      </div>
    </div>
  );
}

/** "Sent to the orchestrator · tracked as request #N", or why there is no link yet. */
function SentLine({
  queued,
  status,
}: {
  readonly queued: boolean;
  readonly status: ReturnType<typeof sentRequestStatus>;
}) {
  const lead = queued ? "Queued for the orchestrator" : "Sent to the orchestrator";
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
