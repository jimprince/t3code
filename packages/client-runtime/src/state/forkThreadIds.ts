import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

export const newForkCommandId = () =>
  CommandId.make(`fork:${Effect.runSync(Random.nextInt)}:${Effect.runSync(Random.nextInt)}`);
