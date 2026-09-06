import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
export const WorkspaceFileDownloadResource = Schema.TaggedStruct("workspace-file-download", {
  threadId: ThreadId,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
