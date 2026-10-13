import type { HarnessSnapshot } from "@t3tools/contracts";
import {
  buildHarnessChecks,
  buildHarnessRunRows,
  describeHarnessFreshness,
  describeHarnessTrend,
  type HarnessCheckView,
  type HarnessRunView,
} from "./harnessView.ts";

/**
 * One check, addressed by where it is reported from: the server that owns it and the stable key
 * its snapshot gives it (`<environmentId>:automation:<id>`, ...). Web puts both in a route, mobile
 * in route params; neither is derived from the check's title.
 */
export interface HarnessCheckRef {
  readonly environmentId: string;
  readonly checkKey: string;
}

export function harnessCheckRef(check: Pick<HarnessCheckView, "key" | "routine">): HarnessCheckRef {
  return { environmentId: check.routine.environmentId, checkKey: check.key };
}

/** One server's last answer, as each client's snapshot hook reports it. */
export interface HarnessEnvironmentRead {
  readonly environmentId: string;
  readonly label: string;
  /** The last answer, kept while a refresh is pending or has failed. */
  readonly snapshot: HarnessSnapshot | null;
  readonly error: string | null;
  readonly isPending?: boolean;
  /** Its server advertises the harnessPin capability. */
  readonly pinSupported?: boolean;
}

export interface HarnessCheckFact {
  readonly label: string;
  readonly value: string;
}

export interface HarnessCheckPage {
  readonly check: HarnessCheckView;
  readonly environmentLabel: string;
  /** Schedule, last and next run, and the error counts a run reported: only what is known. */
  readonly facts: ReadonlyArray<HarnessCheckFact>;
  /** The retained run history, newest first. */
  readonly runs: ReadonlyArray<HarnessRunView>;
  /** Why older runs are missing, when the snapshot kept only part of the history. */
  readonly historyNote: string | null;
  /** When the server was last read, and whether that is old enough to doubt. */
  readonly freshness: { readonly label: string; readonly stale: boolean };
  /** The last refresh failed; the page shows the last read, marked stale. */
  readonly readError: string | null;
}

export type HarnessCheckPageState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "not-found"; readonly message: string }
  | { readonly kind: "found"; readonly page: HarnessCheckPage };

const NOT_FOUND = "This check was not found, or its server no longer reports it.";

/**
 * "Findings per run: 1.5 / run (1 2 0)", only when some retained run reported a count. A check
 * whose runs never report one says nothing: "unknown" on every page would be noise, and it is
 * never shown as zero. The contract carries no "expected to report findings" flag, so a check
 * whose runs all skipped the count stays hidden until one reports.
 */
export function describeFindingsLine(check: Pick<HarnessCheckView, "errors">): string | null {
  const { errors } = check;
  return errors.known ? `${errors.label}${errors.trend ? ` (${errors.trend})` : ""}` : null;
}

function describeFacts(check: HarnessCheckView): ReadonlyArray<HarnessCheckFact> {
  const { routine, errors } = check;
  const runtime = describeHarnessTrend(routine.runtimeErrorsPerRun);
  const findings = describeFindingsLine(check);
  const facts: Array<HarnessCheckFact | null> = [
    { label: "Schedule", value: check.schedule },
    {
      label: "Last run",
      value: [check.lastRunLabel ?? "No run yet", check.livenessLabel]
        .filter((part) => part !== null)
        .join(" · "),
    },
    check.nextLabel === null ? null : { label: "Next expected", value: check.nextLabel },
    runtime.known
      ? {
          label: "Errors per run",
          value: `${runtime.label}${runtime.trend ? ` (${runtime.trend})` : ""}`,
        }
      : null,
    findings === null ? null : { label: "Findings per run", value: findings },
    errors.failedLabel === null ? null : { label: "Failed runs", value: errors.failedLabel },
  ];
  return facts.filter((fact) => fact !== null);
}

/**
 * What a check's own page shows, from the same snapshot the list reads. A server that has not
 * answered is loading or failed, a snapshot without the key is "not found", and a refresh that
 * failed after a good read keeps that read, marked stale (the check itself drops to Source stale).
 */
export function resolveHarnessCheckPage(
  environments: ReadonlyArray<HarnessEnvironmentRead>,
  ref: HarnessCheckRef,
  now: number,
  options: { readonly deviceZone?: string | undefined } = {},
): HarnessCheckPageState {
  const environment = environments.find((entry) => entry.environmentId === ref.environmentId);
  if (environment === undefined) {
    // Not connected (yet) or not serving harness checks: the page cannot tell which.
    return { kind: "not-found", message: NOT_FOUND };
  }
  const { snapshot } = environment;
  if (snapshot === null) {
    return environment.error === null
      ? { kind: "loading" }
      : {
          kind: "error",
          message: `Could not load the checks on ${environment.label}: ${environment.error}`,
        };
  }
  const check = buildHarnessChecks([snapshot], now, {
    ...options,
    unreachable: environment.error === null ? new Set() : new Set([environment.environmentId]),
    pinEnabled:
      environment.pinSupported === true ? new Set([environment.environmentId]) : new Set(),
  }).find((entry) => entry.key === ref.checkKey);
  if (check === undefined) return { kind: "not-found", message: NOT_FOUND };
  const { routine } = check;
  return {
    kind: "found",
    page: {
      check,
      environmentLabel: environment.label,
      facts: describeFacts(check),
      runs: buildHarnessRunRows(routine, now),
      historyNote: routine.historyCoverage.truncated ? routine.historyCoverage.evidence : null,
      freshness: describeHarnessFreshness(snapshot.generatedAt, now),
      readError: environment.error,
    },
  };
}
