import * as Schema from "effect/Schema";
/** Read only the admitted release collector fields, preserving each collector's own clock. */
export const ReleaseHealth = Schema.Struct({
  release: Schema.Struct({
    installed: Schema.Struct({
      hosts: Schema.Array(
        Schema.Struct({
          host: Schema.String,
          version: Schema.NullOr(Schema.String),
          checked_at: Schema.String,
        }),
      ),
      published_tag: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
    upstream_nightly_lag_days: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    latest_upstream_nightly: Schema.optionalKey(Schema.NullOr(Schema.String)),
    next_release: Schema.optionalKey(
      Schema.Struct({
        eta: Schema.NullOr(Schema.String),
        label: Schema.String,
        progress: Schema.String,
      }),
    ),
    source: Schema.optionalKey(Schema.Struct({ refreshed_at: Schema.String })),
    nightly_sync: Schema.optionalKey(Schema.Struct({ state: Schema.String })),
  }),
});
