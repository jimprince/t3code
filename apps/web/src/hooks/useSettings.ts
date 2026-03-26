/**
 * Unified settings hook.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Consumers use `useSettings(selector)` to read, and `useUpdateSettings()` to
 * write. The hook transparently routes reads/writes to the correct backing
 * store.
 */
import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ServerSettings,
  ServerSettingsPatch,
  ServerConfig,
  ModelSelection,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { useLocalStorage } from "./useLocalStorage";
import { normalizeCustomModelSlugs } from "~/modelSelection";
import {
  ClientSettingsSchema,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  CLIENT_SETTINGS_STORAGE_KEY,
} from "~/clientSettings";
import { Predicate, Schema, Struct } from "effect";
import { DeepMutable } from "effect/Types";
import { deepMerge } from "@t3tools/shared/Struct";

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  clientPatch: Partial<ClientSettings>;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as Partial<ClientSettings>,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Read merged settings. Selector narrows the subscription so components
 * only re-render when the slice they care about changes.
 */

export function useSettings<T extends UnifiedSettings = UnifiedSettings>(
  selector?: (s: UnifiedSettings) => T,
): T {
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const [clientSettings] = useLocalStorage(
    CLIENT_SETTINGS_STORAGE_KEY,
    DEFAULT_CLIENT_SETTINGS,
    ClientSettingsSchema,
  );

  const merged = useMemo<UnifiedSettings>(
    () => ({
      ...(serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS),
      ...clientSettings,
    }),
    [serverConfig?.settings, clientSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in the React Query cache, then
 * persisted via RPC. Client keys go straight to localStorage.
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  const [, setClientSettings] = useLocalStorage(
    CLIENT_SETTINGS_STORAGE_KEY,
    DEFAULT_CLIENT_SETTINGS,
    ClientSettingsSchema,
  );

  const updateSettings = useCallback(
    (patch: Partial<UnifiedSettings>) => {
      const { serverPatch, clientPatch } = splitPatch(patch);

      if (Object.keys(serverPatch).length > 0) {
        // Optimistic update of the React Query cache
        queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (old) => {
          if (!old) return old;
          return {
            ...old,
            settings: deepMerge(old.settings, serverPatch),
          };
        });
        // Fire-and-forget RPC — push will reconcile on success
        void ensureNativeApi().server.updateSettings(serverPatch);
      }

      if (Object.keys(clientPatch).length > 0) {
        setClientSettings((prev) => ({ ...prev, ...clientPatch }));
      }
    },
    [queryClient, setClientSettings],
  );

  const resetSettings = useCallback(() => {
    updateSettings({
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
    });
  }, [updateSettings]);

  return {
    updateSettings,
    resetSettings,
    defaults: { ...DEFAULT_SERVER_SETTINGS, ...DEFAULT_CLIENT_SETTINGS } as UnifiedSettings,
  };
}

// ── One-time migration from localStorage ─────────────────────────────

const MIGRATION_FLAG_KEY = "t3code:settings-migrated";
const OLD_SETTINGS_KEY = "t3code:app-settings:v1";

export function buildLegacyServerSettingsMigrationPatch(legacySettings: Record<string, unknown>) {
  const patch: DeepMutable<ServerSettingsPatch> = {};

  if (Predicate.isBoolean(legacySettings.enableAssistantStreaming)) {
    patch.enableAssistantStreaming = legacySettings.enableAssistantStreaming;
  }

  if (Schema.is(ThreadEnvMode)(legacySettings.defaultThreadEnvMode)) {
    patch.defaultThreadEnvMode = legacySettings.defaultThreadEnvMode;
  }

  if (Schema.is(ModelSelection)(legacySettings.textGenerationModelSelection)) {
    patch.textGenerationModelSelection = legacySettings.textGenerationModelSelection;
  }

  if (typeof legacySettings.codexBinaryPath === "string") {
    patch.providers ??= {};
    patch.providers.codex ??= {};
    patch.providers.codex.binaryPath = legacySettings.codexBinaryPath;
  }

  if (typeof legacySettings.codexHomePath === "string") {
    patch.providers ??= {};
    patch.providers.codex ??= {};
    patch.providers.codex.homePath = legacySettings.codexHomePath;
  }

  if (Array.isArray(legacySettings.customCodexModels)) {
    patch.providers ??= {};
    patch.providers.codex ??= {};
    patch.providers.codex.customModels = normalizeCustomModelSlugs(
      legacySettings.customCodexModels,
      "codex",
    );
  }

  if (Predicate.isString(legacySettings.claudeBinaryPath)) {
    patch.providers ??= {};
    patch.providers.claudeAgent ??= {};
    patch.providers.claudeAgent.binaryPath = legacySettings.claudeBinaryPath;
  }

  if (Array.isArray(legacySettings.customClaudeModels)) {
    patch.providers ??= {};
    patch.providers.claudeAgent ??= {};
    patch.providers.claudeAgent.customModels = normalizeCustomModelSlugs(
      legacySettings.customClaudeModels,
      "claudeAgent",
    );
  }

  return patch;
}

/**
 * Call once on app startup. Migrates server-relevant settings from the
 * old localStorage key to the server. Idempotent.
 */
export function migrateLocalSettingsToServer(): void {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(MIGRATION_FLAG_KEY)) return;

  const raw = localStorage.getItem(OLD_SETTINGS_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATION_FLAG_KEY, "true");
    return;
  }

  try {
    const old = JSON.parse(raw);
    if (!Predicate.isObject(old)) return;

    const api = ensureNativeApi();

    const serverPatch = buildLegacyServerSettingsMigrationPatch(old);

    if (Object.keys(serverPatch).length === 0) {
      localStorage.setItem(MIGRATION_FLAG_KEY, "true");
      return;
    }

    void api.server.updateSettings(serverPatch);
    localStorage.setItem(MIGRATION_FLAG_KEY, "true");
  } catch (error) {
    console.error("[MIGRATION] Error migrating local settings to server:", error);
  } finally {
    // Mark as migrated no matter what to avoid retrying
    localStorage.setItem(MIGRATION_FLAG_KEY, "true");
  }
}
