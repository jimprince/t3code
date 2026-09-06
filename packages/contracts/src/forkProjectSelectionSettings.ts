import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const HiddenProjectKeys = Schema.Array(Schema.String);

export const forkProjectSelectionClientSettings = {
  sidebarHiddenProjectKeys: HiddenProjectKeys.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
};

export const forkProjectSelectionClientSettingsPatch = {
  sidebarHiddenProjectKeys: Schema.optionalKey(HiddenProjectKeys),
};
