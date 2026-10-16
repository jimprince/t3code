import {
  buildTemplateFromDraft,
  draftFromSubhead,
  parseVersionConflict,
  permissionChanges,
  RUNTIME_MODE_LABEL,
  type SubheadDraft,
  type SubheadWorkspaceType,
} from "@t3tools/client-runtime/state/subheads-view";
import type { EnvironmentId, RuntimeMode, Subhead } from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { useSubheadCall } from "./useSubheadCommand";

const SELECT_CLASS =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-base text-foreground sm:h-8 sm:text-sm dark:bg-input/32";
const WORKSPACE_LABEL: Record<SubheadWorkspaceType, string> = {
  default: "Project default",
  root: "Project root",
  worktree: "New worktree from a base ref",
  existing_worktree: "Existing worktree",
};

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function Fixed({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-h-8 break-words rounded-lg border border-input/60 px-2.5 py-1.5 text-sm text-muted-foreground">
        {value}
      </span>
    </div>
  );
}

/**
 * Edits the template as a new version. Name, project and owning head are shown but not editable:
 * the server refuses a change to any of them. A change that gives future runs more reach is
 * listed and needs a second click, and a lost-update or any other refusal is shown as the
 * server wrote it.
 */
export function SubheadEditForm({
  environmentId,
  subhead,
  projectTitle,
  ownerTitle,
  latestVersion,
  onCancel,
  onSaved,
  onReload,
}: {
  readonly environmentId: EnvironmentId;
  /** The subhead as it was when Edit was clicked; the form edits this, whatever the poll reads. */
  readonly subhead: Subhead;
  /** The version the server holds now; a newer one than `subhead` means someone saved meanwhile. */
  readonly latestVersion: number;
  readonly projectTitle: string;
  readonly ownerTitle: string;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
  /** Restarts the form from the newest version, dropping the draft. */
  readonly onReload: () => void;
}) {
  const call = useSubheadCall(environmentId);
  const [draft, setDraft] = useState<SubheadDraft>(() => draftFromSubhead(subhead));
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [confirm, setConfirm] = useState<ReadonlyArray<string> | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // State updates are asynchronous: a fast double Enter would send two edits with one version.
  const inFlight = useRef(false);
  const set = <K extends keyof SubheadDraft>(key: K, value: SubheadDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setConfirm(null);
  };
  const conflict = refusal === null ? null : parseVersionConflict(refusal);
  const save = async () => {
    if (inFlight.current) return;
    const built = buildTemplateFromDraft(subhead, draft);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    const changes = permissionChanges(subhead, built.template);
    if (changes.length > 0 && confirm === null) {
      setConfirm(changes);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setRefusal(null);
    const result = await call({
      operation: "edit",
      name: subhead.name,
      expectedVersion: subhead.version,
      template: built.template,
    });
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      setRefusal(result.message);
      return;
    }
    onSaved();
  };
  return (
    <form
      aria-label={`Edit ${subhead.name}`}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Editing v{subhead.version}. Saving creates v{subhead.version + 1} for future requests; runs
        already open keep v{subhead.version}.
      </p>
      {latestVersion > subhead.version ? (
        <div role="status" className="flex flex-col items-start gap-1.5 text-sm text-warning-foreground">
          <p>
            v{latestVersion} was saved while you were editing v{subhead.version}. Your draft is
            kept, but saving it will be refused until you reload.
          </p>
          <Button size="xs" variant="outline" type="button" onClick={onReload}>
            Reload v{latestVersion} and drop the draft
          </Button>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Fixed label="Name (cannot change)" value={subhead.name} />
        <Fixed label="Project (cannot change)" value={projectTitle} />
        <Fixed label="Owning head (cannot change)" value={ownerTitle} />
      </div>
      <Field label="Description">
        <Input
          value={draft.description}
          onChange={(event) => set("description", event.target.value)}
        />
      </Field>
      <Field label="Instructions (inline text)">
        <Textarea value={draft.prompt} onChange={(event) => set("prompt", event.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Provider instance">
          <Input
            font="mono"
            value={draft.instanceId}
            onChange={(event) => set("instanceId", event.target.value)}
          />
        </Field>
        <Field
          label="Model"
          hint={
            subhead.modelSelection.options?.length
              ? "Changing the model drops its selected options."
              : "No silent model fallback."
          }
        >
          <Input
            font="mono"
            value={draft.model}
            onChange={(event) => set("model", event.target.value)}
          />
        </Field>
        <Field
          label="Runtime mode ceiling"
          hint="Restricted modes need a provider that enforces them; enabling checks this."
        >
          <select
            className={SELECT_CLASS}
            value={draft.runtimeMode}
            onChange={(event) => set("runtimeMode", event.target.value as RuntimeMode)}
          >
            {(Object.keys(RUNTIME_MODE_LABEL) as RuntimeMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {RUNTIME_MODE_LABEL[mode]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Concurrency cap"
          hint="Runs at the same time; the head's own cap still applies."
        >
          <select
            className={SELECT_CLASS}
            value={draft.concurrency}
            onChange={(event) => set("concurrency", event.target.value)}
          >
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </Field>
        <Field label="Workspace">
          <select
            className={SELECT_CLASS}
            value={draft.workspaceType}
            onChange={(event) => set("workspaceType", event.target.value as SubheadWorkspaceType)}
          >
            {(Object.keys(WORKSPACE_LABEL) as SubheadWorkspaceType[]).map((type) => (
              <option key={type} value={type}>
                {WORKSPACE_LABEL[type]}
              </option>
            ))}
          </select>
        </Field>
        {draft.workspaceType === "worktree" || draft.workspaceType === "existing_worktree" ? (
          <Field label={draft.workspaceType === "worktree" ? "Base ref" : "Worktree path"}>
            <Input
              font="mono"
              value={draft.workspaceRef}
              onChange={(event) => set("workspaceRef", event.target.value)}
            />
          </Field>
        ) : null}
        {draft.workspaceType !== "default" ? (
          <Field label="Branch (optional)">
            <Input
              font="mono"
              value={draft.workspaceBranch}
              onChange={(event) => set("workspaceBranch", event.target.value)}
            />
          </Field>
        ) : null}
      </div>
      {errors.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-sm text-error">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      {confirm !== null ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-warning-foreground">
          <p className="font-medium">
            This edit broadens what future runs may do. Confirm to save:
          </p>
          <ul className="list-disc pl-5">
            {confirm.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {refusal !== null ? (
        <div role="alert" className="flex flex-col items-start gap-1.5 text-sm text-error">
          <p className="break-words">{refusal}</p>
          {conflict !== null ? (
            <>
              <p className="text-muted-foreground">
                v{conflict.current} was saved after you opened v{conflict.expected}. Your changes
                were not saved.
              </p>
              <Button size="xs" variant="outline" type="button" onClick={onReload}>
                Reload v{conflict.current}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {confirm !== null ? "Confirm and save new version" : "Save as new version"}
        </Button>
      </div>
    </form>
  );
}
