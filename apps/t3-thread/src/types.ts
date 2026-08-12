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
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: OrchestrationLatestTurn | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
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
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: OrchestrationLatestTurn | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  session: OrchestrationSession | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
}

export interface OrchestrationMessage {
  id: string;
  role: "user" | "assistant" | "system";
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

export interface SavedSubscription {
  subscriberThreadId: string;
  subscriberAgentName: string | null;
  subscriberEnvironment: string;
  sourceThreadId: string;
  sourceAgentName: string | null;
  sourceEnvironment: string;
  createdAt: string;
  updatedAt: string;
}

export type SavedNotificationStatus = "pending" | "delivering" | "delivered" | "delivery-failed";

export interface SavedNotification {
  id: string;
  eventKey: string;
  subscriberThreadId: string;
  subscriberAgentName: string | null;
  subscriberEnvironment: string;
  sourceThreadId: string;
  sourceAgentName: string | null;
  sourceEnvironment: string;
  sourceState: AgentState;
  reason: string;
  latestAssistantMessageId: string | null;
  latestTurnId: string | null;
  preview: string | null;
  status: SavedNotificationStatus;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string | null;
  lastAttemptedAt?: string | null;
  lastError?: string | null;
  deliveryClaimId?: string | null;
}

export interface StateFile {
  version: 1;
  environments: SavedEnvironment[];
  agents: SavedAgent[];
  subscriptions: SavedSubscription[];
  notifications: SavedNotification[];
}

export type AgentState =
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
