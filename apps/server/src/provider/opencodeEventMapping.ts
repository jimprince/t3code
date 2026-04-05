import type {
  AssistantMessage,
  FileDiff,
  Model as OpenCodeModel,
  PermissionRuleset,
  Provider as OpenCodeSdkProvider,
} from "@opencode-ai/sdk/v2/client";
import type {
  CanonicalItemType,
  CanonicalRequestType,
  RuntimeMode,
  RuntimePlanStepStatus,
  RuntimeTurnState,
  ServerProvider,
} from "@t3tools/contracts";

const FILE_READ_TOOLS = new Set(["read", "list", "glob", "grep"]);
const FILE_CHANGE_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
const SUPERVISED_PERMISSION_NAMES = new Set([
  ...FILE_READ_TOOLS,
  ...FILE_CHANGE_TOOLS,
  "bash",
  "external_directory",
]);

export function toOpenCodeModel(input: string | undefined | null) {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }

  const delimiterIndex = trimmed.indexOf("/");
  if (delimiterIndex <= 0 || delimiterIndex === trimmed.length - 1) {
    return undefined;
  }

  return {
    providerID: trimmed.slice(0, delimiterIndex),
    modelID: trimmed.slice(delimiterIndex + 1),
  };
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "approval-required") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*", action: "ask" },
      { permission: "list", pattern: "*", action: "ask" },
      { permission: "glob", pattern: "*", action: "ask" },
      { permission: "grep", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "write", pattern: "*", action: "ask" },
      { permission: "patch", pattern: "*", action: "ask" },
      { permission: "multiedit", pattern: "*", action: "ask" },
      { permission: "apply_patch", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: "*", action: "ask" },
    ];
  }

  return [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "doom_loop", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "allow" },
  ];
}

export function runtimeModeFromOpenCodePermissionRules(
  rules: PermissionRuleset | undefined | null,
): RuntimeMode | undefined {
  if (!rules) {
    return undefined;
  }

  for (const rule of rules) {
    const permission = rule.permission.trim().toLowerCase();
    const action = rule.action.trim().toLowerCase();
    if (action === "ask" && SUPERVISED_PERMISSION_NAMES.has(permission)) {
      return "approval-required";
    }
  }

  return "full-access";
}

function modelLabel(provider: OpenCodeSdkProvider, model: OpenCodeModel): string {
  return `${provider.name.trim()} / ${model.name.trim()}`;
}

function modelSlug(provider: OpenCodeSdkProvider, model: OpenCodeModel): string {
  return `${provider.id}/${model.id}`;
}

function pickDefaultModel(input: {
  readonly providers: ReadonlyArray<OpenCodeSdkProvider>;
  readonly defaultByProvider: Record<string, string>;
}): string {
  for (const provider of input.providers) {
    const configured = input.defaultByProvider[provider.id];
    if (configured && provider.models[configured]) {
      return `${provider.id}/${configured}`;
    }
  }

  for (const provider of input.providers) {
    const firstModel = Object.values(provider.models)[0];
    if (firstModel) {
      return modelSlug(provider, firstModel);
    }
  }

  return "openai/gpt-5.4";
}

export function toOpenCodeProviderCatalog(input: {
  readonly providers: ReadonlyArray<OpenCodeSdkProvider>;
  readonly defaultByProvider: Record<string, string>;
}): {
  readonly defaultModel: string;
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
} {
  const models = input.providers
    .flatMap((provider) =>
      Object.values(provider.models).map(
        (model) =>
          ({
            slug: modelSlug(provider, model),
            name: modelLabel(provider, model),
            isCustom: false,
            capabilities: null,
          }) satisfies ServerProvider["models"][number],
      ),
    )
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug),
    );

  return {
    defaultModel: pickDefaultModel(input),
    models,
  };
}

export function toCanonicalToolItemType(toolName: string | undefined): CanonicalItemType {
  const normalized = toolName?.trim().toLowerCase();
  if (!normalized) {
    return "dynamic_tool_call";
  }

  if (normalized === "bash") {
    return "command_execution";
  }

  if (FILE_CHANGE_TOOLS.has(normalized)) {
    return "file_change";
  }

  if (normalized === "task") {
    return "collab_agent_tool_call";
  }

  if (normalized === "websearch" || normalized === "webfetch" || normalized === "codesearch") {
    return "web_search";
  }

  return "dynamic_tool_call";
}

export function toCanonicalRequestType(input: {
  readonly permission?: string | undefined;
  readonly toolName?: string | undefined;
}): CanonicalRequestType {
  const normalizedToolName = input.toolName?.trim().toLowerCase();
  if (normalizedToolName === "bash") {
    return "command_execution_approval";
  }
  if (normalizedToolName && FILE_READ_TOOLS.has(normalizedToolName)) {
    return "file_read_approval";
  }
  if (normalizedToolName && FILE_CHANGE_TOOLS.has(normalizedToolName)) {
    return "file_change_approval";
  }

  const normalizedPermission = input.permission?.trim().toLowerCase();
  if (!normalizedPermission) {
    return "unknown";
  }

  if (normalizedPermission === "bash") {
    return "command_execution_approval";
  }
  if (FILE_READ_TOOLS.has(normalizedPermission)) {
    return "file_read_approval";
  }
  if (FILE_CHANGE_TOOLS.has(normalizedPermission)) {
    return "file_change_approval";
  }
  if (normalizedPermission === "external_directory") {
    return normalizedToolName && FILE_CHANGE_TOOLS.has(normalizedToolName)
      ? "file_change_approval"
      : normalizedToolName === "bash"
        ? "command_execution_approval"
        : "file_read_approval";
  }

  return "unknown";
}

export function toRuntimePlanStepStatus(status: string | undefined): RuntimePlanStepStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "in_progress":
    case "in-progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

export function toRuntimeTurnState(message: AssistantMessage): RuntimeTurnState {
  if (!message.error) {
    return "completed";
  }

  if (message.error.name === "MessageAbortedError") {
    return "interrupted";
  }

  return "failed";
}

export function toOpenCodeErrorMessage(
  error: AssistantMessage["error"] | undefined,
): string | undefined {
  if (!error) {
    return undefined;
  }

  const data =
    "data" in error && error.data && typeof error.data === "object" ? error.data : undefined;
  const message =
    data && "message" in data && typeof data.message === "string" ? data.message : undefined;
  return message ?? error.name;
}

export function buildOpenCodeDiffSummary(diffs: ReadonlyArray<FileDiff>): string {
  return diffs
    .map((diff) => {
      const file = diff.file;
      const status = diff.status ?? "modified";
      return [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        `@@ ${status} +${diff.additions} -${diff.deletions} @@`,
      ].join("\n");
    })
    .join("\n");
}

export function isPlanAgent(agent: string | undefined): boolean {
  return agent?.trim().toLowerCase() === "plan";
}
