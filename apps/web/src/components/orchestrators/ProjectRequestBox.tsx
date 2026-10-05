import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { MessageId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { saveRequestForLater } from "../../state/projectRoadmap";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { sendToOrchestrator } from "./sendToOrchestrator";

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
 * The project page's request box: Send gives the text (and pasted or dropped
 * images) verbatim to the project's orchestrator through the normal send path,
 * where the request ledger captures it; Save for later files it straight into
 * the roadmap's Later column without waking the orchestrator.
 */
export function ProjectRequestBox({
  summary,
  onSent,
}: {
  readonly summary: OrchestratorSummary;
  /** Called with the sent message so the page can open the chat on the reply. */
  readonly onSent?: (messageId: MessageId) => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const saveForLater = useAtomCommand(saveRequestForLater, "Save for later");
  const statusTimer = useRef<number | null>(null);
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  // Previews are object URLs; release them when the box goes away.
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
      if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
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
    const sent = sendToOrchestrator(summary, text, images);
    reset();
    flash(sent.queued ? "Queued for the orchestrator" : "Sent");
    onSent?.(sent.messageId);
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
        {status ? (
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        ) : null}
      </div>
    </div>
  );
}
