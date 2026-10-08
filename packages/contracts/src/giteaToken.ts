import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Wrap before validation: even malformed objects must not enter decoder defects unredacted.
export const GiteaTokenSetInput = Schema.RedactedFromValue(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Redacted(
      Schema.Struct({
        instanceId: TrimmedNonEmptyString,
        token: Schema.String.check(Schema.isPattern(/^(?!redacted$)[\x21-\x7e]{1,4096}$/i)),
      }),
    ),
    SchemaTransformation.passthrough({ strict: false }),
  ),
);
export type GiteaTokenSetInput = typeof GiteaTokenSetInput.Type;

export const GiteaTokenSetResult = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  tokenSet: Schema.Boolean,
  storedMatchesInput: Schema.Boolean,
});
export type GiteaTokenSetResult = typeof GiteaTokenSetResult.Type;

export class GiteaTokenSetError extends Schema.TaggedError<GiteaTokenSetError>()(
  "GiteaTokenSetError",
  { reason: Schema.Literals(["invalid-input", "unknown-instance", "storage-failed"]) },
) {
  override get message(): string {
    return "Could not update the existing Gitea instance token.";
  }
}
