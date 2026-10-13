import { HarnessCheckPinSetInput, HarnessPinError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Settings from "../serverSettings.ts";

export class HarnessPinService extends Context.Service<
  HarnessPinService,
  {
    readonly setPinned: (
      input: HarnessCheckPinSetInput,
    ) => Effect.Effect<readonly string[], HarnessPinError>;
  }
>()("t3/harness/HarnessPinService") {}

const decodeInput = Schema.decodeUnknownEffect(HarnessCheckPinSetInput);
const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const setPinned = Effect.fn("HarnessPinService.setPinned")(function* (
    input: HarnessCheckPinSetInput,
  ) {
    const { checkKey, pinned } = yield* decodeInput(input).pipe(
      Effect.mapError((cause) => new HarnessPinError({ cause })),
    );
    const next = yield* settings
      .updateSettings((current) => {
        const keys = [...new Set(current.harnessPinnedCheckKeys)];
        return {
          harnessPinnedCheckKeys: pinned
            ? keys.includes(checkKey)
              ? keys
              : [...keys, checkKey]
            : keys.filter((key) => key !== checkKey),
        };
      })
      .pipe(Effect.mapError((cause) => new HarnessPinError({ cause })));
    return next.harnessPinnedCheckKeys;
  });
  return HarnessPinService.of({ setPinned });
});
export const layer = Layer.effect(HarnessPinService, make);
