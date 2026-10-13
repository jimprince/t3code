import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { DashboardAttention, DashboardTask } from "@t3tools/contracts";
import { createContext, use } from "react";

import type {
  Baseline,
  Change,
  DashboardData,
  ScopedProject,
  SourceHealth,
} from "./dashboard.logic";
import type { DecisionAnswers } from "./useDecisionAnswers";

export interface DecisionRow {
  /** `projectKey|attentionId`: unique across environments. */
  readonly key: string;
  readonly scoped: ScopedProject;
  readonly attention: DashboardAttention;
}

/** What every part of the Dashboard reads, so the variants stay thin arrangements of shared rows. */
export interface DashboardUi {
  readonly data: DashboardData;
  /** The revision of the snapshot on screen, as the cold-load trace's section markers report it. */
  readonly revision: string;
  readonly now: number;
  /** Every open decision in scope, already in the order of the one feed. */
  readonly decisions: ReadonlyArray<DecisionRow>;
  readonly answers: DecisionAnswers;
  /** The decisions blocking a task, as keys; empty when none or already answered. */
  readonly decisionKeysFor: (scoped: ScopedProject, task: DashboardTask) => ReadonlyArray<string>;
  readonly openDecisions: (keys: ReadonlyArray<string>) => void;
  readonly openTask: (scoped: ScopedProject, task: DashboardTask) => void;
  readonly openProject: (scoped: ScopedProject) => void;
  readonly summaryFor: (scoped: ScopedProject) => OrchestratorSummary | null;
  readonly sourceHealth: (sourceId: string) => SourceHealth | null;
  readonly isCollapsed: (key: string, defaultCollapsed: boolean) => boolean;
  readonly toggleCollapsed: (key: string) => void;
  /** Changes since this device last looked; null on a first visit, when there is nothing to compare. */
  readonly sinceLooked: {
    readonly baseline: Baseline;
    readonly changes: ReadonlyArray<Change>;
    readonly outcomes: ReadonlyArray<Change>;
  } | null;
  /** The project this page is scoped to, or null on Home. */
  readonly root: ScopedProject | null;
  /** Pre-fills the Ask box with an editable message to the owner; nothing is sent. */
  readonly prefill: { readonly text: string; readonly nonce: number } | null;
  readonly unstick: (title: string) => void;
}

const DashboardUiContext = createContext<DashboardUi | null>(null);
export const DashboardUiProvider = DashboardUiContext;

export function useDashboardUi(): DashboardUi {
  const ui = use(DashboardUiContext);
  if (!ui) throw new Error("useDashboardUi outside DashboardView");
  return ui;
}
