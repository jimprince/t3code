import path from "node:path";

import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
} from "./vendor/t3contracts/model.js";
import type { ModelSelection, OrchestrationProjectShell, OrchestrationThreadShell } from "./types.js";

export type ProjectCreateCommandInput = {
  commandId: string;
  projectId: string;
  title: string;
  workspaceRoot: string;
  createWorkspaceRootIfMissing?: boolean;
  defaultModelSelection?: ModelSelection | null;
  createdAt: string;
};

export type ProjectMetaUpdateCommandInput = {
  commandId: string;
  projectId: string;
  title?: string;
  workspaceRoot?: string;
  defaultModelSelection?: ModelSelection | null;
};

export type ProjectDeleteCommandInput = {
  commandId: string;
  projectId: string;
  force?: boolean;
};

export function normalizeProjectPath(workspaceRoot: string): string {
  const trimmed = workspaceRoot.trim();
  if (!trimmed) {
    throw new Error("Project path cannot be empty.");
  }
  if (trimmed.startsWith("~")) {
    throw new Error("Project path must be absolute; shell-expand '~' before passing it to t3-thread.");
  }
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed);
  if (!path.posix.isAbsolute(trimmed) && !isWindowsPath) {
    throw new Error(`Project path must be absolute: ${workspaceRoot}`);
  }
  const normalized = isWindowsPath ? path.win32.normalize(trimmed) : path.posix.normalize(trimmed);
  if (isWindowsPath) {
    const parsed = path.win32.parse(normalized);
    return normalized === parsed.root ? normalized : normalized.replace(/[\\/]+$/, "");
  }
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function normalizeProjectTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("Project title cannot be empty.");
  }
  return trimmed;
}

export function deriveProjectTitle(workspaceRoot: string, explicitTitle?: string): string {
  if (explicitTitle !== undefined) {
    return normalizeProjectTitle(explicitTitle);
  }

  const normalized = normalizeProjectPath(workspaceRoot);
  const baseName = (path.win32.isAbsolute(normalized) ? path.win32.basename(normalized) : path.posix.basename(normalized)).trim();
  return baseName || "project";
}

export function parseModelOptionEntries(entries: string[] = []): Record<string, unknown> | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const options: Record<string, unknown> = {};
  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Model option must be formatted as key=value: ${entry}`);
    }
    const key = entry.slice(0, separatorIndex).trim();
    const rawValue = entry.slice(separatorIndex + 1).trim();
    if (!key) {
      throw new Error(`Model option key cannot be empty: ${entry}`);
    }
    if (rawValue === "true") {
      options[key] = true;
    } else if (rawValue === "false") {
      options[key] = false;
    } else {
      options[key] = rawValue;
    }
  }

  return options;
}

function resolveModelSlug(provider: string, model?: string): string {
  const providerDefaults = DEFAULT_MODEL_BY_PROVIDER as Record<string, string>;
  const providerAliases = MODEL_SLUG_ALIASES_BY_PROVIDER as Record<string, Record<string, string>>;
  const trimmedModel = model?.trim();
  const fallbackModel = providerDefaults[provider] ?? DEFAULT_MODEL;
  if (!trimmedModel) {
    return fallbackModel;
  }
  return providerAliases[provider]?.[trimmedModel] ?? trimmedModel;
}

export function buildModelSelection(input: {
  provider?: string;
  model?: string;
  optionEntries?: string[];
  clear?: boolean;
  noDefault?: boolean;
}): ModelSelection | null {
  if (input.clear) {
    if (input.provider || input.model || (input.optionEntries?.length ?? 0) > 0 || input.noDefault) {
      throw new Error("`--clear` cannot be combined with model provider, model, options, or --no-default-model.");
    }
    return null;
  }

  if (input.noDefault) {
    if (input.provider || input.model || (input.optionEntries?.length ?? 0) > 0) {
      throw new Error("`--no-default-model` cannot be combined with model provider, model, or options.");
    }
    return null;
  }

  const provider = input.provider?.trim() || "codex";
  const model = resolveModelSlug(provider, input.model);
  const options = parseModelOptionEntries(input.optionEntries);
  return {
    provider,
    model,
    ...(options ? { options } : {}),
  };
}

export function resolveProjectTarget(
  projects: OrchestrationProjectShell[],
  identifier: string,
): OrchestrationProjectShell {
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw new Error("Project identifier cannot be empty.");
  }

  const idMatch = projects.find((project) => project.id === trimmed);
  if (idMatch) {
    return idMatch;
  }

  const normalizedPath = normalizeProjectPath(trimmed);
  const pathMatches = projects.filter((project) => normalizeProjectPath(project.workspaceRoot) === normalizedPath);
  if (pathMatches.length === 1) {
    return pathMatches[0]!;
  }
  if (pathMatches.length > 1) {
    throw new Error(`Multiple active projects use '${normalizedPath}'. Re-run with the project id.`);
  }

  throw new Error(`No active project found for '${trimmed}'.`);
}

export function findExistingProjectByPath(
  projects: OrchestrationProjectShell[],
  workspaceRoot: string,
): OrchestrationProjectShell | null {
  const normalizedPath = normalizeProjectPath(workspaceRoot);
  return projects.find((project) => normalizeProjectPath(project.workspaceRoot) === normalizedPath) ?? null;
}

export function listThreadsForProject(
  threads: OrchestrationThreadShell[],
  projectId: string,
): OrchestrationThreadShell[] {
  return threads.filter((thread) => thread.projectId === projectId);
}

export function buildProjectCreateCommand(input: ProjectCreateCommandInput) {
  return {
    type: "project.create" as const,
    commandId: input.commandId,
    projectId: input.projectId,
    title: input.title,
    workspaceRoot: normalizeProjectPath(input.workspaceRoot),
    ...(input.createWorkspaceRootIfMissing ? { createWorkspaceRootIfMissing: true } : {}),
    ...(input.defaultModelSelection !== undefined
      ? { defaultModelSelection: input.defaultModelSelection }
      : {}),
    createdAt: input.createdAt,
  };
}

export function buildProjectMetaUpdateCommand(input: ProjectMetaUpdateCommandInput) {
  return {
    type: "project.meta.update" as const,
    commandId: input.commandId,
    projectId: input.projectId,
    ...(input.title !== undefined ? { title: normalizeProjectTitle(input.title) } : {}),
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: normalizeProjectPath(input.workspaceRoot) } : {}),
    ...(input.defaultModelSelection !== undefined
      ? { defaultModelSelection: input.defaultModelSelection }
      : {}),
  };
}

export function buildProjectDeleteCommand(input: ProjectDeleteCommandInput) {
  return {
    type: "project.delete" as const,
    commandId: input.commandId,
    projectId: input.projectId,
    ...(input.force ? { force: true } : {}),
  };
}
