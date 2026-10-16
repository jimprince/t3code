import type { EnvironmentId, Subhead, SubheadRunRow } from "@t3tools/contracts";
import { describeSubheadModel } from "@t3tools/client-runtime/state/subheads-view";
import { useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { useSubheadCall } from "./useSubheadCommand";

/** What this request will do, from the runs already open: start now or wait behind them. */
export function describeSendOutcome(subhead: Subhead, openRuns: ReadonlyArray<SubheadRunRow>) {
  const queued = openRuns.filter((run) => run.status === "queued").length;
  if (openRuns.length < subhead.concurrency)
    return { text: "This request starts now.", warn: false };
  return {
    text: `${openRuns.length} run${openRuns.length === 1 ? " is" : "s are"} already open (cap ${subhead.concurrency}). This request queues, position ${queued + 1}.`,
    warn: true,
  };
}

/**
 * The request id and text not yet accepted, per subhead. A dialog closed after a timeout and
 * reopened resumes the same id, so a request the server did receive is never run twice; the entry
 * is dropped only once a send succeeds.
 */
const unsent = new Map<string, { requestId: string; message: string }>();
const unsentKey = (environmentId: string, name: string) => `${environmentId}:${name}`;

/**
 * Sends one request to a subhead. The sender is the authenticated session, not a field, and the
 * result is pull-only because a browser session has no thread to return to: it is read from the
 * run's history row. The request id is generated here and shown, so a retry returns the same
 * receipt instead of starting a second run.
 */
export function SubheadSendDialog({
  environmentId,
  subhead,
  openRuns,
  onClose,
  onSent,
}: {
  readonly environmentId: EnvironmentId;
  readonly subhead: Subhead;
  readonly openRuns: ReadonlyArray<SubheadRunRow>;
  readonly onClose: () => void;
  readonly onSent: () => void;
}) {
  const call = useSubheadCall(environmentId);
  const key = unsentKey(environmentId, subhead.name);
  const [requestId] = useState(() => {
    const kept = unsent.get(key);
    if (kept) return kept.requestId;
    const created = `r-${randomUUID().slice(0, 8)}`;
    unsent.set(key, { requestId: created, message: "" });
    return created;
  });
  const [message, setMessage] = useState(() => unsent.get(key)?.message ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ runId: string; status: string } | null>(null);
  // A fast double submit must not send twice before the first answer sets `pending`.
  const inFlight = useRef(false);
  const outcome = describeSendOutcome(subhead, openRuns);
  const submit = async () => {
    if (inFlight.current) return;
    if (message.trim() === "") {
      setError("Write the request first.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    const result = await call({
      operation: "send",
      name: subhead.name,
      requestId,
      request: message,
    });
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    unsent.delete(key);
    const value = result.value as { runId?: string; status?: string };
    setReceipt({ runId: value.runId ?? requestId, status: value.status ?? "queued" });
    onSent();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Send to {subhead.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3 text-sm">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">To</dt>
                <dd className="min-w-0 break-words">
                  <span className="font-medium">{subhead.name}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    template · no live session · v{subhead.version} ·{" "}
                    {describeSubheadModel(subhead.modelSelection)}
                  </span>
                </dd>
                <dt className="text-muted-foreground">From</dt>
                <dd>
                  this session{" "}
                  <span className="text-xs text-muted-foreground">
                    (authenticated, not editable)
                  </span>
                </dd>
              </dl>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Message</span>
                <Textarea
                  aria-label="Request"
                  autoFocus
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value);
                    unsent.set(key, { requestId, message: event.target.value });
                  }}
                />
              </label>
              <p>
                <span className="text-muted-foreground">Result goes to </span>pull only
                <span className="text-muted-foreground">
                  {" "}
                  · read it from this run in the history below
                </span>
              </p>
              <p className="text-muted-foreground">
                A fresh thread is created from the template and the result is kept with the run.
              </p>
              <p className={outcome.warn ? "text-warning-foreground" : "text-muted-foreground"}>
                {outcome.text}
              </p>
              <p className="text-xs text-muted-foreground">
                request id {requestId} · a retry returns the same receipt
              </p>
              {error !== null ? (
                <p role="alert" className="break-words text-error">
                  {error} The request id and text are kept, so sending again is safe.
                </p>
              ) : null}
              {receipt !== null ? (
                <p role="status" className="break-words text-success-foreground">
                  Sent. Run {receipt.runId} is {receipt.status}. Its result will appear in the
                  history below; read it there.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            {receipt !== null ? (
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  Send
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
