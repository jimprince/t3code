import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** One identity per server runtime, independent of persisted environment identity and kernel boot. */
export class ServerIncarnation extends Context.Service<
  ServerIncarnation,
  {
    readonly id: string;
    readonly startedAt: string;
  }
>()("t3/threadRecovery/ServerIncarnation") {}
export const layer = Layer.effect(
  ServerIncarnation,
  Effect.gen(function* () {
    return { id: NodeCrypto.randomUUID(), startedAt: DateTime.formatIso(yield* DateTime.now) };
  }),
);
