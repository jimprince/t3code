import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  /**
   * Routing key for the configured provider instance that owns this
   * session. The persistence layer promotes legacy null rows before
   * exposing bindings; runtime callers must not infer this from `provider`.
   */
  readonly providerInstanceId?: ProviderInstanceId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
  readonly bootGenerationId?: string | null;
  readonly activeTurnId?: TurnId | null;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
  readonly bootGenerationId: string | null;
}

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryShape {
  readonly upsert: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ProviderSessionDirectoryReadError>;

  readonly listThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly listBindings: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly settleDeadGenerationBinding: (input: {
    readonly threadId: ThreadId;
    readonly expectedBootGenerationId: string | null;
  }) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;

  readonly markTurnStarted: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly expectedActiveTurnId?: TurnId | null;
  }) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;

  readonly markTurnTerminal: (input: {
    readonly threadId: ThreadId;
    readonly expectedTurnId: TurnId;
  }) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;

  readonly claimIdleForRecovery: (input: {
    readonly threadId: ThreadId;
    readonly expectedLastSeenAt: string;
  }) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;
}

export class ProviderSessionDirectory extends Context.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("t3/provider/Services/ProviderSessionDirectory") {}
