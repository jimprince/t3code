import * as Context from "effect/Context";

export interface ServerBootGenerationShape {
  readonly bootGenerationId: string;
}

export class ServerBootGeneration extends Context.Service<
  ServerBootGeneration,
  ServerBootGenerationShape
>()("t3/provider/Services/ServerBootGeneration") {}
