import type { ProjectAutomation } from "@t3tools/contracts";
import type { MessageOrigin } from "@t3tools/shared/messageOrigin";

export interface ServerAuthDescriptor {
  policy: string;
  bootstrapMethods: string[];
  sessionMethods: string[];
  sessionCookieName: string;
}

export interface AuthSessionState {
  authenticated: boolean;
  auth: ServerAuthDescriptor;
  role?: string;
  sessionMethod?: string;
  expiresAt?: string;
}

export interface AuthAccessTokenResult {
  access_token: string;
  token_type: "Bearer";
  issued_token_type: string;
  expires_in: number;
  scope?: string;
}

export type AuthSessionRefreshResult = AuthAccessTokenResult;

export interface AuthWebSocketTicketResult {
  ticket: string;
  expiresAt: string;
}

export interface ExecutionEnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: {
    os: string;
    arch: string;
  };
  serverVersion: string;
  capabilities: {
    repositoryIdentity?: boolean;
    threadPinReorder?: boolean;
    threadActiveReorder?: boolean;
    threadOrderReset?: boolean;
    sessionRefresh?: boolean;
    threadNesting?: boolean;
    remoteThreadNesting?: boolean;
    threadIssues?: boolean;
  };
}

export interface ModelSelection {
  provider: string;
  model: string;
  options?: Record<string, unknown>;
}

export interface OrchestrationLatestTurn {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
}

export interface OrchestrationSession {
  threadId: string;
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  providerName: string | null;
  runtimeMode: string;
  activeTurnId: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface OrchestrationProjectShell {
  automations?: readonly ProjectAutomation[];
  id: string;
  title: string;
  workspaceRoot: string;
  repositoryIdentity?: Record<string, unknown> | null;
  defaultModelSelection: ModelSelection | null;
  scripts?: Array<Record<string, unknown>>;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrchestrationProposedPlan {
  id: string;
  turnId: string | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationThread {
  parentThreadId?: string | null;
  remoteParent?: { environmentId: string; threadId: string } | null;
  id: string;
  projectId: string;
  title: string;
  scope?: string | null;
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  issues?: readonly ThreadIssueLink[];
  latestTurn: OrchestrationLatestTurn | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settledOverride?: "settled" | "active" | null;
  autoSettleDisabledAt?: string | null | undefined;
  pinnedAt?: string | null | undefined;
  pinOrderKey?: string | null | undefined;
  activeOrderKey?: string | null | undefined;
  settledAt?: string | null;
  unsettledAt?: string | null;
  deletedAt?: string | null;
  messages: OrchestrationMessage[];
  proposedPlans: OrchestrationProposedPlan[];
  activities: Array<Record<string, unknown>>;
  checkpoints: Array<Record<string, unknown>>;
  session: OrchestrationSession | null;
}

export interface OrchestrationShellSnapshot {
  snapshotSequence: number;
  projects: OrchestrationProjectShell[];
  threads: OrchestrationThreadShell[];
  updatedAt: string;
}

export interface OrchestrationThreadShell {
  parentThreadId?: string | null;
  remoteParent?: { environmentId: string; threadId: string } | null;
  id: string;
  projectId: string;
  title: string;
  scope?: string | null;
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  issues?: readonly ThreadIssueLink[];
  latestTurn: OrchestrationLatestTurn | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settledOverride?: "settled" | "active" | null;
  autoSettleDisabledAt?: string | null | undefined;
  pinnedAt?: string | null | undefined;
  pinOrderKey?: string | null | undefined;
  activeOrderKey?: string | null | undefined;
  settledAt?: string | null;
  unsettledAt?: string | null;
  session: OrchestrationSession | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
}

export interface ThreadIssueLink {
  host: string;
  repository: string;
  number: number;
  url: string;
  linkedAt: string;
  snapshot: { title: string; state: "open" | "closed"; syncedAt: string };
}

export interface OrchestrationMessage {
  id: string;
  role: "user" | "assistant" | "system" | "reasoning";
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationReadModel {
  snapshotSequence: number;
  projects: OrchestrationProjectShell[];
  threads: OrchestrationThread[];
  updatedAt: string;
}

export interface SavedEnvironment {
  name: string;
  httpBaseUrl: string;
  wsBaseUrl: string;
  environmentId: string;
  label: string;
  serverVersion: string;
  bearerToken: string;
  expiresAt: string;
  pairedAt: string;
}

export interface SavedAgent {
  name: string;
  environment: string;
  threadId: string;
  projectId: string;
  title: string;
  createdAt: string;
  lastSeenAssistantMessageId?: string | null;
}

export type NotificationLevel = "all" | "attention" | "none";

export interface SavedSubscription {
  /** Implicit parent routing, refreshed from the current nesting rather than a saved opt-in. */
  nestingDerived?: boolean;
  /** Opt-in inactivity monitoring; zero or absent disables it. */
  inactivityMinutes?: number;
  inactivityObservation?: {
    turnId: string;
    activityAt: string;
    quietSince: string;
    observedAt: string;
  } | null;
  level?: NotificationLevel;
  /** Minutes before the single unanswered nested-child reminder; zero disables reminders. */
  inputReminderMinutes?: number;
  lastDirectMessageTurnId?: string | null;
  errorEventKey?: string | null;
  observedState?: AgentState;
  observedReason?: string;
  subscriberThreadId: string;
  subscriberAgentName: string | null;
  subscriberEnvironment: string;
  /** Stable descriptor ID for remote-parent routing, independent of saved aliases. */
  subscriberEnvironmentId?: string;
  sourceThreadId: string;
  sourceAgentName: string | null;
  sourceEnvironment: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The source's latest turn when the subscription was created. Attention for
   * that turn predates the subscriber's interest and is never routed, so
   * subscribing to a thread that already completed or errored does not replay
   * that old state as a fresh event. Null or absent means no baseline.
   */
  baselineTurnId?: string | null;
}

/**
 * Delivery lifecycle of a routed notification.
 *
 * `pending` and `delivery-failed` are retryable, `delivering` is claimed by one
 * watcher, and the rest are terminal for the watcher: `delivered` succeeded,
 * `undeliverable` can never succeed (recipient gone, attempts exhausted), and
 * `blocked` needs an operator action first (expired environment credentials),
 * and `superseded` was overtaken by a newer event for the same route before it
 * was delivered. `held` waits for settlement or a current-turn quota block
 * to clear. It is rechecked while running; only a known quota reset keeps
 * the watcher awake for automatic recovery.
 */
export type SavedNotificationStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "delivery-failed"
  | "held"
  | "blocked"
  | "undeliverable"
  | "superseded";

export interface SavedNotification {
  inactivityActivityAt?: string;
  pendingQuestion?: string | null;
  pendingInputRequestKey?: string | null;
  isChildInput?: boolean;
  reminderOfEventKey?: string | null;
  completionDisposition?: "quiet" | "attention" | null;
  occurrences?: number;
  lastOccurrenceKey?: string;
  id: string;
  eventKey: string;
  subscriberThreadId: string;
  subscriberAgentName: string | null;
  subscriberEnvironment: string;
  /** Stable descriptor ID for remote-parent routing, independent of saved aliases. */
  subscriberEnvironmentId?: string;
  sourceThreadId: string;
  sourceAgentName: string | null;
  sourceEnvironment: string;
  sourceState: AgentState;
  reason: string;
  latestAssistantMessageId: string | null;
  latestTurnId: string | null;
  preview: string | null;
  status: SavedNotificationStatus;
  /** Confirmed first-delivery guide; retained across routes and watcher restarts. */
  onboardingDelivered?: boolean;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string | null;
  lastAttemptedAt?: string | null;
  lastError?: string | null;
  deliveryClaimId?: string | null;
  /** Watcher process that owns `deliveryClaimId`, so a slept-through claim is not stolen. */
  deliveryClaimPid?: number | null;
  /** Failed delivery attempts. Waiting on a busy or blocked recipient does not count. */
  attempts?: number;
  /** Earliest time the next attempt may be claimed. Null means immediately. */
  nextAttemptAt?: string | null;
  /** Known quota reset keeps a watcher alive for automatic recovery; absent on old records. */
  quotaResetAt?: string | null;
}

/**
 * Lifecycle of a send that arrived while the target thread was mid-turn.
 *
 * `queued` -> `dispatching` (claimed by one drain pass) -> `dispatched`.
 * `cancelled` is operator-initiated; `undeliverable` is terminal and set when the
 * target can never accept the message (archived thread, exhausted attempts).
 */
export type QueuedSendStatus =
  | "queued"
  | "dispatching"
  | "dispatched"
  | "cancelled"
  | "undeliverable";

/**
 * A send held locally because the target thread was still running. The record is
 * durable state, not process state: the CLI exits right after `send`, and the
 * watcher drains the queue at the next turn boundary.
 */
export interface SavedQueuedSend {
  id: string;
  /** Monotonic per state file. Defines FIFO dispatch order within a thread. */
  sequence: number;
  threadId: string;
  agentName: string | null;
  environment: string;
  text: string;
  /** Sender recorded at enqueue time; absent on sends queued by older CLIs. */
  origin?: MessageOrigin;
  /** Opt-in: a newer open send with the same key, sender and target replaces this one. */
  coalesceKey?: string;
  status: QueuedSendStatus;
  /** Turn that was running when the send was accepted, for operator diagnostics. */
  queuedDuringTurnId: string | null;
  attempts: number;
  queuedAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  lastAttemptedAt: string | null;
  lastError: string | null;
  dispatchClaimId: string | null;
}

export interface StateFile {
  version: 1;
  environments: SavedEnvironment[];
  agents: SavedAgent[];
  subscriptions: SavedSubscription[];
  notifications: SavedNotification[];
  queuedSends: SavedQueuedSend[];
}

export type AgentState =
  | "inactive"
  | "needs-approval"
  | "needs-input"
  | "needs-plan"
  | "error"
  | "running"
  | "interrupted"
  | "completed"
  | "idle"
  | "archived";

export interface AgentStatus {
  state: AgentState;
  reason: string;
}
