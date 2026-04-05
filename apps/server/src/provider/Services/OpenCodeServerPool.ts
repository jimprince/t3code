import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ServerProvider } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../Errors.ts";

export interface OpenCodeServerLease {
  readonly key: string;
  readonly poolRoot: string;
  readonly cwd: string;
  readonly baseUrl: string;
  readonly client: OpencodeClient;
  readonly release: Effect.Effect<void>;
}

export interface OpenCodeServerPoolEvent {
  readonly type: "sidecar.exited";
  readonly key: string;
  readonly poolRoot: string;
  readonly cwd: string;
  readonly baseUrl: string;
  readonly expected: boolean;
  readonly detail?: string;
}

export interface OpenCodeProviderCatalog {
  readonly defaultModel: string;
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
}

export interface OpenCodeServerPoolShape {
  readonly acquire: (input: {
    readonly cwd: string;
    readonly poolRoot?: string | undefined;
    readonly binaryPath?: string | undefined;
  }) => Effect.Effect<
    OpenCodeServerLease,
    ProviderAdapterProcessError | ProviderAdapterRequestError
  >;

  readonly loadProviderCatalog: (input: {
    readonly cwd: string;
    readonly poolRoot?: string | undefined;
    readonly binaryPath?: string | undefined;
  }) => Effect.Effect<
    OpenCodeProviderCatalog,
    ProviderAdapterProcessError | ProviderAdapterRequestError
  >;

  readonly stopAll: () => Effect.Effect<void>;
  readonly streamEvents: Stream.Stream<OpenCodeServerPoolEvent>;
}

export class OpenCodeServerPool extends ServiceMap.Service<
  OpenCodeServerPool,
  OpenCodeServerPoolShape
>()("t3/provider/Services/OpenCodeServerPool") {}
