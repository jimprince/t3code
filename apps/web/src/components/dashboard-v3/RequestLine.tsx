import { issueNumber } from "@t3tools/client-runtime/dashboard/order";
import type { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn, randomUUID } from "../../lib/utils";
import { readThreadShells } from "../../state/entities";
import { fileProjectRequest, settleProjectRequest } from "../../state/projectIssues";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { useDashboardUi } from "./context";
import { topLevelProjects, type ScopedProject } from "./dashboard.logic";
import {
  defaultEpic,
  filingInput,
  kindFromText,
  nextKeyLabel,
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
 * tracker before the owner is told, and the result is the notice line under the box.
 */
export function RequestLine({ projectHead }: { readonly projectHead: ScopedProject | null }) {
  const ui = useDashboardUi();
  const file = useAtomCommand(fileProjectRequest, { reportFailure: false });
  const settle = useAtomCommand(settleProjectRequest, { reportFailure: false });
  const [text, setText] = useState("");
  const [kind, setKind] = useState<LineKind>("task");
  // Typing "Bug:" selects Bug unless the user has chosen a type by hand.
  const chosenKind = useRef(false);
  const [busy, setBusy] = useState(false);
  // A failed filing keeps its id, so Enter again lands on the issue it may already have made.
  const attempt = useRef<{ readonly text: string; readonly id: string } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

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

  if (!target || target.project.rootThreadId === null) return null;
  const threadId = target.project.rootThreadId as ThreadId;

  const change = (value: string) => {
    setText(value);
    if (!chosenKind.current) setKind(kindFromText(value) ?? "task");
  };

  const submit = async (placement: LinePlacement) => {
    const words = text.trim();
    if (busy || !words) return;
    const id = attempt.current?.text === text ? attempt.current.id : randomUUID();
    attempt.current = { text, id };
    setBusy(true);
    const input = filingInput({
      threadId,
      text,
      kind,
      epic: kind === "epic" ? null : epic,
      placement,
      messageId: id,
    });
    const result = await file({ environmentId: target.environmentId, input });
    setBusy(false);
    if (result._tag !== "Success") {
      // Nothing is lost: the words stay in the box and Enter retries the same filing.
      ui.report({ tone: "error", text: `Not filed: ${failureText(result)}`, actions: [] });
      return;
    }
    attempt.current = null;
    const { request, queued, placeError, notifiedThreadId } = result.value;
    setText("");
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
    const undo = {
      label: "Undo",
      run: () =>
        void settle({
          environmentId: target.environmentId,
          input: {
            rootThreadId: threadId,
            host: request.host,
            repository: request.repository,
            number: request.number,
          },
        }).then((closed) =>
          ui.report({
            tone: closed._tag === "Success" ? "ok" : "error",
            text:
              closed._tag === "Success"
                ? `Closed #${request.number}: filed by mistake.`
                : `Could not close #${request.number}: ${failureText(closed)}`,
            actions: [],
          }),
        ),
    };
    ui.report(
      placeError
        ? {
            tone: "warn",
            text: `${lead}, but it is not placed: ${placeError}. It is in New.${told}`,
            actions: [undo],
          }
        : { tone: "ok", text: `${lead}, ${placed}.${told}`, actions: [undo] },
    );
  };

  const modifier = nextKeyLabel(typeof navigator === "undefined" ? "" : navigator.platform);
  return (
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
        disabled={busy}
        placeholder={`New request. Enter files it last, ${modifier}Enter files it next`}
        className="field-sizing-content max-h-40 min-h-6 min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 outline-none placeholder:text-muted-foreground/70"
        onChange={(event) => change(event.target.value)}
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
      {projectHead === null && targets.length > 1 ? (
        <select
          aria-label="Project"
          value={target.key}
          className="max-w-44 shrink-0 bg-transparent text-xs text-muted-foreground"
          onChange={(event) => {
            setLastProject(event.target.value);
            setPickedEpic(null);
          }}
        >
          {targets.map((scoped) => (
            <option key={scoped.key} value={scoped.key} className="bg-popover">
              {scoped.project.title}
            </option>
          ))}
        </select>
      ) : null}
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
      <Button size="xs" disabled={busy || !text.trim()} onClick={() => void submit("last")}>
        File
      </Button>
    </div>
  );
}

/** The line under the request box: what the last filing or move did, and the way back. */
export function NoticeLine() {
  const { notice, dismissNotice } = useDashboardUi();
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
