import {
  ClientOrchestrationCommand as SharedClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationRpcSchemas,
  ORCHESTRATION_WS_METHODS,
} from "@t3tools/contracts/orchestration";
import { EnvironmentAuthorizationError } from "@t3tools/contracts/auth";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import type {
  OrchestrationShellSnapshot as CliOrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "./types.js";

type SharedCodec = Schema.Codec<unknown, unknown, never>;
type Direction = "cli" | "wire";
type Mapper = (value: unknown, direction: Direction) => unknown;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function mapModelSelection(value: unknown, direction: Direction): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (typeof record.model !== "string") {
    return value;
  }

  if (direction === "cli" && typeof record.instanceId === "string") {
    const { instanceId, options, ...rest } = record;
    return {
      ...rest,
      provider: instanceId,
      ...(Array.isArray(options) ? { options: Object.fromEntries(options.map(optionEntry)) } : {}),
    };
  }

  if (direction === "wire" && typeof record.provider === "string") {
    const { provider, options, ...rest } = record;
    return {
      ...rest,
      instanceId: provider,
      ...(options !== undefined ? { options: optionArray(options) } : {}),
    };
  }

  return value;
}

function optionEntry(value: unknown): [string, unknown] {
  if (value === null || typeof value !== "object") {
    return ["", value];
  }
  const entry = value as Record<string, unknown>;
  return [typeof entry.id === "string" ? entry.id : "", entry.value];
}

function optionArray(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.entries(value).map(([id, optionValue]) => ({ id, value: optionValue }));
}

function mapField(record: Record<string, unknown>, key: string, direction: Direction) {
  if (!(key in record)) return record;
  const mapped = mapModelSelection(record[key], direction);
  return mapped === record[key] ? record : { ...record, [key]: mapped };
}

function mapProject(value: unknown, direction: Direction): unknown {
  const record = asRecord(value);
  return record ? mapField(record, "defaultModelSelection", direction) : value;
}

function mapThread(value: unknown, direction: Direction): unknown {
  const record = asRecord(value);
  return record ? mapField(record, "modelSelection", direction) : value;
}

function mapArray(values: unknown, mapper: Mapper, direction: Direction): unknown {
  if (!Array.isArray(values)) return values;
  let changed = false;
  const mapped = values.map((value) => {
    const next = mapper(value, direction);
    changed ||= next !== value;
    return next;
  });
  return changed ? mapped : values;
}

function mapShellSnapshot(value: unknown, direction: Direction): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const projects = mapArray(record.projects, mapProject, direction);
  const threads = mapArray(record.threads, mapThread, direction);
  return projects === record.projects && threads === record.threads
    ? value
    : { ...record, projects, threads };
}

function mapEvent(value: unknown, direction: Direction): unknown {
  const event = asRecord(value);
  if (!event) return value;
  const mapper =
    event.type === "project.created" || event.type === "project.meta-updated"
      ? mapProject
      : event.type === "thread.created" ||
          event.type === "thread.meta-updated" ||
          event.type === "thread.turn-start-requested"
        ? mapThread
        : undefined;
  if (!mapper) return value;
  const payload = mapper(event.payload, direction);
  return payload === event.payload ? value : { ...event, payload };
}

function mapShellStreamItem(value: unknown, direction: Direction): unknown {
  const item = asRecord(value);
  if (!item) return value;
  const mapped =
    item.kind === "snapshot"
      ? mapShellSnapshot(item.snapshot, direction)
      : item.kind === "project-upserted"
        ? mapProject(item.project, direction)
        : item.kind === "thread-upserted"
          ? mapThread(item.thread, direction)
          : undefined;
  const key =
    item.kind === "snapshot"
      ? "snapshot"
      : item.kind === "project-upserted"
        ? "project"
        : item.kind === "thread-upserted"
          ? "thread"
          : undefined;
  return key && mapped !== item[key] ? { ...item, [key]: mapped } : value;
}

function mapThreadStreamItem(value: unknown, direction: Direction): unknown {
  const item = asRecord(value);
  if (!item) return value;
  if (item.kind === "snapshot") {
    const snapshot = asRecord(item.snapshot);
    if (!snapshot) return value;
    const thread = mapThread(snapshot.thread, direction);
    return thread === snapshot.thread ? value : { ...item, snapshot: { ...snapshot, thread } };
  }
  if (item.kind === "event") {
    const event = mapEvent(item.event, direction);
    return event === item.event ? value : { ...item, event };
  }
  return value;
}

function mapClientCommand(value: unknown, direction: Direction): unknown {
  const command = asRecord(value);
  if (!command) return value;
  if (command.type === "project.create" || command.type === "project.meta.update") {
    return mapProject(command, direction);
  }
  if (
    command.type !== "thread.create" &&
    command.type !== "thread.meta.update" &&
    command.type !== "thread.turn.start"
  ) {
    return value;
  }

  let mapped = mapThread(command, direction) as Record<string, unknown>;
  if (command.type !== "thread.turn.start") return mapped;
  const bootstrap = asRecord(mapped.bootstrap);
  if (!bootstrap) return mapped;
  const createThread = mapThread(bootstrap.createThread, direction);
  if (createThread === bootstrap.createThread) return mapped;
  return { ...mapped, bootstrap: { ...bootstrap, createThread } };
}

function compatibleOrchestrationCodec(schema: SharedCodec, mapper: Mapper): SharedCodec {
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transformEffect({
        decode: (raw) =>
          Schema.decodeUnknownEffect(schema)(raw).pipe(
            Effect.map((decoded) => mapper(decoded, "cli")),
            Effect.mapError((error) => new SchemaIssue.InvalidValue({ message: error.message })),
          ),
        encode: (value) =>
          Schema.encodeUnknownEffect(schema)(mapper(value, "wire")).pipe(
            Effect.mapError((error) => new SchemaIssue.InvalidValue({ message: error.message })),
          ),
      }),
    ),
  );
}

const sharedCommand = SharedClientOrchestrationCommand as SharedCodec;
const sharedShellSnapshot = OrchestrationRpcSchemas.getArchivedShellSnapshot.output as SharedCodec;
const sharedShellStreamItem = OrchestrationRpcSchemas.subscribeShell.output as SharedCodec;
const sharedThreadStreamItem = OrchestrationRpcSchemas.subscribeThread.output as SharedCodec;

export const ClientOrchestrationCommand = compatibleOrchestrationCodec(
  sharedCommand,
  mapClientCommand,
);
const CompatibleOrchestrationShellSnapshot = compatibleOrchestrationCodec(
  sharedShellSnapshot,
  mapShellSnapshot,
);
export const OrchestrationShellStreamItem = compatibleOrchestrationCodec(
  sharedShellStreamItem,
  mapShellStreamItem,
);
export const OrchestrationThreadStreamItem = compatibleOrchestrationCodec(
  sharedThreadStreamItem,
  mapThreadStreamItem,
);

const OptionalString = Schema.optionalKey(Schema.String);

const ServerProviderModel = Schema.Struct({
  slug: Schema.String,
  name: OptionalString,
  shortName: OptionalString,
  isCustom: Schema.optionalKey(Schema.Boolean),
});

export const ServerProvider = Schema.Struct({
  provider: OptionalString,
  instanceId: OptionalString,
  driver: OptionalString,
  displayName: OptionalString,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: Schema.String,
  models: Schema.Array(ServerProviderModel),
});

export type ServerProvider = typeof ServerProvider.Type;

export const ServerConfig = Schema.Struct({
  providers: Schema.Array(ServerProvider),
});

export type ServerConfig = typeof ServerConfig.Type;

const decodeOrchestrationShellStreamItem = Schema.decodeUnknownSync(OrchestrationShellStreamItem);
const decodeOrchestrationThreadStreamItem = Schema.decodeUnknownSync(OrchestrationThreadStreamItem);
const decodeCompatibleServerConfig = Schema.decodeUnknownSync(ServerConfig);
const decodeCompatibleServerProvider = Schema.decodeUnknownSync(ServerProvider);
const encodeCompatibleClientCommand = Schema.encodeUnknownSync(ClientOrchestrationCommand);

export function decodeShellSnapshotItem(input: unknown): {
  kind: "snapshot";
  snapshot: CliOrchestrationShellSnapshot;
} {
  const decoded = decodeOrchestrationShellStreamItem(input);
  const record = decoded as Record<string, unknown>;
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    record.kind !== "snapshot" ||
    !("snapshot" in decoded)
  ) {
    throw new Error("Expected an orchestration shell snapshot.");
  }
  return decoded as { kind: "snapshot"; snapshot: CliOrchestrationShellSnapshot };
}

export function decodeShellStreamItem(input: unknown): unknown {
  return decodeOrchestrationShellStreamItem(input);
}

export function decodeThreadSnapshotItem(input: unknown): {
  kind: "snapshot";
  snapshot: { snapshotSequence: number; thread: OrchestrationThread };
} {
  const decoded = decodeOrchestrationThreadStreamItem(input);
  const record = decoded as Record<string, unknown>;
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    record.kind !== "snapshot" ||
    !("snapshot" in decoded)
  ) {
    throw new Error("Expected an orchestration thread snapshot.");
  }
  return decoded as {
    kind: "snapshot";
    snapshot: { snapshotSequence: number; thread: OrchestrationThread };
  };
}

export function decodeThreadStreamItem(input: unknown): unknown {
  return decodeOrchestrationThreadStreamItem(input);
}

export function decodeThreadShell(input: unknown): OrchestrationThreadShell {
  const decoded = decodeShellSnapshotItem({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 0,
      projects: [],
      threads: [input],
      updatedAt: "1970-01-01T00:00:00.000Z",
    },
  });
  const thread = decoded.snapshot.threads[0];
  if (!thread) {
    throw new Error("Expected an orchestration thread shell.");
  }
  return thread;
}

export function decodeServerConfig(input: unknown): ServerConfig {
  return decodeCompatibleServerConfig(input);
}

export function decodeServerProvider(input: unknown): ServerProvider {
  return decodeCompatibleServerProvider(input);
}

export function encodeClientOrchestrationCommand(input: unknown): unknown {
  return encodeCompatibleClientCommand(input);
}

export const WS_SERVER_GET_CONFIG_METHOD = "server.getConfig";

const WsServerGetConfigRpc = Rpc.make(WS_SERVER_GET_CONFIG_METHOD, {
  payload: Schema.Struct({}),
  success: ServerConfig,
});

const WsOrchestrationDispatchCommandRpc = Rpc.make(ORCHESTRATION_WS_METHODS.dispatchCommand, {
  payload: ClientOrchestrationCommand,
  success: OrchestrationRpcSchemas.dispatchCommand.output,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationRpcSchemas.getTurnDiff.input,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
  payload: OrchestrationRpcSchemas.getFullThreadDiff.input,
  success: OrchestrationRpcSchemas.getFullThreadDiff.output,
  error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: CompatibleOrchestrationShellSnapshot,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationShellStreamItem,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationSubscribeThreadRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeThread, {
  payload: OrchestrationRpcSchemas.subscribeThread.input,
  success: OrchestrationThreadStreamItem,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
