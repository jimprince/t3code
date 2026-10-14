import { issueNumber } from "@t3tools/client-runtime/dashboard/order";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent,
} from "react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachment,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { cn, randomUUID } from "../../lib/utils";
import { readThreadShells } from "../../state/entities";
import { fileProjectRequest, withdrawProjectRequest } from "../../state/projectIssues";
import { saveRequestForLater } from "../../state/projectRoadmap";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  imageAttachment,
  imageFiles,
  ProjectRequestBox,
  REQUEST_QUICK_ACTIONS,
} from "../orchestrators/ProjectRequestBox";
import { attemptKey } from "../orchestrators/sendOutcome.logic";
import { Button, InlineButton } from "../ui/button";
import { useDashboardUi, useNotice } from "./context";
import { topLevelProjects, type ScopedProject } from "./dashboard.logic";
import {
  defaultEpic,
  filingInput,
  kindFromText,
  nextKeyHint,
  placementOf,
  type LineKind,
  type LinePlacement,
} from "./requestLine.logic";
import { failureText } from "./orderActions";

const KINDS: ReadonlyArray<{ readonly kind: LineKind; readonly label: string }> = [
  { kind: "task", label: "Task" },
  { kind: "bug", label: "Bug" },
  { kind: "epic", label: "Epic" },
];

const LastEpics = Schema.Record(Schema.String, Schema.Number);
const NO_EPICS: Readonly<Record<string, number>> = {};

/** The Home project picker's value for the Chief of Staff: words sent to the desk, not filed. */
const CHIEF = "chief-of-staff";

/** The open epics of a project, in the order its Plan shows them. */
function epicOptions(scoped: ScopedProject) {
  return scoped.project.workstreams.flatMap((workstream) => {
    const number = typeof workstream.url === "string" ? issueNumber(workstream.id) : null;
    return number === null ? [] : [{ number, title: workstream.title }];
  });
}

/**
 * The one-line request box: Task, Bug or Epic, the workstream, then the words. Enter files the
 * item last in its workstream, Cmd or Ctrl with Enter files it next. The issue exists in the
 * tracker before the owner is told, and the result is the notice line under the box. Pasted or
 * dropped images are uploaded as the old box did and filed with the item. Focusing the empty line
 * shows the quick starters, "Save for later" parks the words in the Roadmap without filing, and on
 * Home the picker's Chief of Staff choice sends the old box's message to the desk.
 */
export function RequestLine({
  projectHead,
  chief,
}: {
  readonly projectHead: ScopedProject | null;
  /** Home's Chief of Staff, when there is one: a target of the project picker. */
  readonly chief: OrchestratorSummary | null;
}) {
  const ui = useDashboardUi();
  const file = useAtomCommand(fileProjectRequest, { reportFailure: false });
  const withdraw = useAtomCommand(withdrawProjectRequest, { reportFailure: false });
  const saveForLater = useAtomCommand(saveRequestForLater, "Save for later");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<LineKind>("task");
  // Typing "Bug:" selects Bug unless the user has chosen a type by hand.
  const chosenKind = useRef(false);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  // A failed filing keeps its id, so Enter again lands on the issue it may already have made.
  // The words and the images together make the filing.
  const attempt = useRef<{ readonly key: string; readonly id: string } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  // Set by a starter so the caret lands after the text it puts in the line.
  const caretToEnd = useRef(false);

  const targets = useMemo(
    () =>
      projectHead
        ? [projectHead]
        : topLevelProjects(ui.data.projects).products.filter((scoped) => ui.order.canFile(scoped)),
    [projectHead, ui.data.projects, ui.order],
  );
  const [lastProject, setLastProject] = useLocalStorage(
    "t3.dashboard.request.project",
    "",
    Schema.String,
  );
  const toChief =
    projectHead === null && chief !== null && (lastProject === CHIEF || targets.length === 0);
  const target = targets.find((scoped) => scoped.key === lastProject) ?? targets[0] ?? null;
  const [lastEpics, setLastEpics] = useLocalStorage(
    "t3.dashboard.request.epics",
    NO_EPICS,
    LastEpics,
  );
  const epics = useMemo(() => (target ? epicOptions(target) : []), [target]);
  const [pickedEpic, setPickedEpic] = useState<{ project: string; epic: number | null } | null>(
    null,
  );
  const epic =
    pickedEpic && target && pickedEpic.project === target.key
      ? pickedEpic.epic
      : defaultEpic(
          epics.map((option) => option.number),
          target ? lastEpics[target.key] : undefined,
        );

  const prefillNonce = useRef(ui.prefill?.nonce ?? 0);
  useEffect(() => {
    if (!ui.prefill || ui.prefill.nonce === prefillNonce.current) return;
    prefillNonce.current = ui.prefill.nonce;
    setText(ui.prefill.text);
    field.current?.focus();
  }, [ui.prefill]);

  // Previews are object URLs; release them when the line goes away.
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );
  useLayoutEffect(() => {
    const input = field.current;
    if (!caretToEnd.current || !input) return;
    caretToEnd.current = false;
    input.setSelectionRange(input.value.length, input.value.length);
  });

  const change = (value: string) => {
    setText(value);
    if (!chosenKind.current) setKind(kindFromText(value) ?? "task");
  };

  const addImages = (files: File[]) => {
    if (files.length === 0 || busy || !target) return;
    const added = files.map(imageAttachment);
    for (const image of added)
      startAttachmentUpload({ environmentId: target.environmentId, image });
    setImages((current) => [...current, ...added]);
  };
  const removeImage = (image: ComposerImageAttachment) => {
    releaseDraftAttachment(image);
    URL.revokeObjectURL(image.previewUrl);
    setImages((current) => current.filter((item) => item.id !== image.id));
  };
  /** Drops every image still in the line: it is for one environment, and the target changed. */
  const discardImages = () => {
    for (const image of imagesRef.current) {
      releaseDraftAttachment(image);
      URL.revokeObjectURL(image.previewUrl);
    }
    setImages([]);
  };

  const picker =
    projectHead === null && targets.length + (chief ? 1 : 0) > 1 ? (
      <select
        aria-label="Project"
        value={toChief ? CHIEF : (target?.key ?? "")}
        className="max-w-44 shrink-0 bg-transparent text-xs text-muted-foreground"
        onChange={(event) => {
          const value = event.target.value;
          const next = targets.find((scoped) => scoped.key === value) ?? null;
          setLastProject(value);
          setPickedEpic(null);
          if (next?.environmentId !== target?.environmentId) discardImages();
        }}
      >
        {targets.map((scoped) => (
          <option key={scoped.key} value={scoped.key} className="bg-popover">
            {scoped.project.title}
          </option>
        ))}
        {chief ? (
          <option value={CHIEF} className="bg-popover">
            to Chief of Staff
          </option>
        ) : null}
      </select>
    ) : null;

  if (toChief && chief)
    return (
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <ProjectRequestBox
            summary={chief}
            quickActions={REQUEST_QUICK_ACTIONS}
            prefill={ui.prefill}
            placeholder={`New request to ${chief.root.title}`}
          />
        </div>
        <span className="pt-1">{picker}</span>
      </div>
    );
  if (!target || target.project.rootThreadId === null) return null;
  const threadId = target.project.rootThreadId as ThreadId;
  const environmentId = target.environmentId;

  const submit = async (placement: LinePlacement) => {
    const words = text.trim();
    if (busy || (!words && images.length === 0)) return;
    const key = attemptKey(
      text,
      images.map((image) => image.id),
    );
    const id = attempt.current?.key === key ? attempt.current.id : randomUUID();
    attempt.current = { key, id };
    setBusy(true);
    const filed = images;
    const done = () => {
      setBusy(false);
      field.current?.focus();
    };
    await awaitAttachmentUploads(filed.map((image) => image.id));
    const uploaded = getUploadedAttachments({ environmentId, images: filed });
    if (uploaded === null) {
      done();
      ui.report({
        tone: "error",
        text: "Not filed: an image did not upload. Your words and images are kept.",
        actions: [],
      });
      return;
    }
    const input = filingInput({
      threadId,
      text,
      kind,
      epic: kind === "epic" ? null : epic,
      placement,
      messageId: id,
      attachments: uploaded.map(({ id: attachmentId, name, mimeType, sizeBytes }) => ({
        id: attachmentId,
        type: "image" as const,
        name,
        mimeType,
        sizeBytes,
      })),
    });
    const result = await file({ environmentId, input });
    done();
    if (result._tag !== "Success") {
      // Nothing is lost: the words and images stay in the line and Enter retries the same filing.
      ui.report({ tone: "error", text: `Not filed: ${failureText(result)}`, actions: [] });
      return;
    }
    attempt.current = null;
    const { request, queued, placeError, notifiedThreadId, attachmentError } = result.value;
    const filedText = text;
    const filedKind = kind;
    const filedEpic = epic;
    setText("");
    for (const image of filed) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
    chosenKind.current = false;
    setKind("task");
    if (kind !== "epic") {
      const { [target.key]: _previous, ...others } = lastEpics;
      setLastEpics(epic === null ? others : { ...others, [target.key]: epic });
    }
    if (!request) {
      ui.report({
        tone: queued ? "warn" : "error",
        text: queued
          ? "The tracker is unreachable. Your words are saved and will be filed when it is back."
          : "Not filed.",
        actions: [],
      });
      return;
    }
    const where =
      kind === "epic"
        ? ""
        : ` in ${epics.find((option) => option.number === epic)?.title ?? "Other work"}`;
    const placed = `${placement === "next" ? "next" : "last"}${where}`;
    const owner = notifiedThreadId
      ? readThreadShells().find((shell) => shell.id === notifiedThreadId)?.title
      : undefined;
    const told =
      notifiedThreadId === undefined
        ? ""
        : notifiedThreadId === null
          ? " Nobody has been told yet."
          : ` Your words are in the issue; ${owner ?? "the owner"} was told.`;
    const lead = `Filed #${request.number} ${kind}`;
    const imageNote = attachmentError ? ` An image was not attached: ${attachmentError}` : "";
    // Undo withdraws the filing, which tells the owner, and puts the words back to fix and refile.
    const undo = {
      label: "Undo",
      run: () =>
        void withdraw({
          environmentId,
          input: { threadId, reference: String(request.number), actor: "brad" },
        }).then((closed) => {
          if (closed._tag !== "Success") {
            ui.report({
              tone: "error",
              text: `Could not withdraw #${request.number}: ${failureText(closed)}`,
              actions: [],
            });
            return;
          }
          const empty = textRef.current.trim() === "";
          if (empty) {
            chosenKind.current = filedKind !== "task";
            setKind(filedKind);
            setText(filedText);
            setPickedEpic({ project: target.key, epic: filedEpic });
            caretToEnd.current = true;
            field.current?.focus();
          }
          ui.report({
            tone: "ok",
            text: `Withdrew #${request.number}${empty ? ". Your words are back in the line" : ""}.`,
            actions: [],
          });
        }),
    };
    ui.report(
      placeError
        ? {
            tone: "warn",
            text: `${lead}, but it is not placed: ${placeError}. It is in New.${told}${imageNote}`,
            actions: [undo],
          }
        : {
            tone: attachmentError ? "warn" : "ok",
            text: `${lead}, ${placed}.${told}${imageNote}`,
            actions: [undo],
          },
    );
  };

  const saveLater = async () => {
    const detail = text.trim();
    if (!detail || images.length > 0) return;
    const result = await saveForLater({
      environmentId,
      input: {
        threadId,
        title: detail.split("\n")[0]!.slice(0, 200),
        kind: "task",
        detail,
        park: true,
      },
    });
    if (result._tag !== "Success") return;
    setText("");
    chosenKind.current = false;
    setKind("task");
    ui.report({ tone: "ok", text: "Saved for later.", actions: [] });
  };

  const hint = nextKeyHint(typeof navigator === "undefined" ? "" : navigator.platform);
  const empty = text.length === 0 && images.length === 0;
  return (
    <div
      className="flex flex-col gap-1"
      // Starters show while the empty line has focus; Tab can still reach them.
      onFocus={() => setFocused(true)}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
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
      <div
        data-testid="dashboard-request-line"
        className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pr-1 pl-1.5"
      >
        <span
          role="group"
          aria-label="Type"
          className="inline-flex shrink-0 divide-x divide-border overflow-hidden rounded-sm border border-border text-xs"
        >
          {KINDS.map((option) => (
            <button
              key={option.kind}
              type="button"
              aria-pressed={kind === option.kind}
              className={cn(
                "px-2 py-px text-muted-foreground",
                kind === option.kind &&
                  (option.kind === "bug"
                    ? "bg-card text-destructive-foreground"
                    : "bg-card text-foreground"),
              )}
              onClick={() => {
                chosenKind.current = true;
                setKind(option.kind);
              }}
            >
              {option.label}
            </button>
          ))}
        </span>
        <textarea
          ref={field}
          aria-label="New request"
          rows={1}
          value={text}
          // Read-only, not disabled: a disabled field drops focus, and the next filing starts typing.
          readOnly={busy}
          placeholder={`New request. Enter files it last, ${hint} files it next`}
          className="field-sizing-content max-h-40 min-h-6 min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => change(event.target.value)}
          onPaste={(event: ClipboardEvent) => {
            const files = imageFiles(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            addImages(files);
          }}
          onKeyDown={(event) => {
            const placement = placementOf({
              key: event.key,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              isComposing: event.nativeEvent.isComposing,
            });
            if (!placement) return;
            event.preventDefault();
            void submit(placement);
          }}
        />
        {picker}
        {kind === "epic" ? null : (
          <select
            aria-label="Workstream"
            value={epic ?? ""}
            className="max-w-52 shrink-0 bg-transparent text-xs text-muted-foreground"
            onChange={(event) =>
              setPickedEpic({
                project: target.key,
                epic: event.target.value === "" ? null : Number(event.target.value),
              })
            }
          >
            <option value="" className="bg-popover">
              No epic
            </option>
            {epics.map((option) => (
              <option key={option.number} value={option.number} className="bg-popover">
                {option.title} #{option.number}
              </option>
            ))}
          </select>
        )}
        {text.trim() && images.length === 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            // Keep the line focused: a blur here would fold the starters before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void saveLater()}
          >
            Save for later
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={busy || (!text.trim() && images.length === 0)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void submit("last")}
        >
          File
        </Button>
      </div>
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
                onClick={() => removeImage(image)}
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {focused && empty ? (
        <div className="flex flex-wrap gap-1.5">
          {REQUEST_QUICK_ACTIONS.map((action) => (
            <Button
              key={action.label}
              size="xs"
              variant="outline"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                caretToEnd.current = true;
                change(action.text);
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The line under the request box: what the last filing or move did, and the way back. */
export function NoticeLine() {
  const notice = useNotice();
  const { dismissNotice } = useDashboardUi();
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-5 flex-wrap items-baseline gap-x-2 px-0.5 text-xs",
        notice?.tone === "error"
          ? "text-destructive-foreground"
          : notice?.tone === "warn"
            ? "text-warning-foreground"
            : "text-muted-foreground",
      )}
    >
      {notice ? (
        <>
          <span>{notice.text}</span>
          {notice.actions.map((action) => (
            <InlineButton
              key={action.label}
              tone="muted"
              // The starters above fold when the line loses focus, which would shift this button
              // between the press and the release and swallow the click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                dismissNotice();
                action.run();
              }}
            >
              {action.label}
            </InlineButton>
          ))}
        </>
      ) : null}
    </div>
  );
}
