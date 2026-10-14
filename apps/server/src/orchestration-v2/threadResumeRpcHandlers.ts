import { ThreadResumeRpc, ThreadResumePreviewRpc, RpcScopeAuthorization } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { ThreadResumeService } from "./ThreadResumeService.ts";
export const group = RpcGroup.make(ThreadResumeRpc, ThreadResumePreviewRpc).middleware(
  RpcScopeAuthorization,
);
export const handlers = group.of({
  "thread.resumeFromPlan": (input) =>
    Effect.flatMap(ThreadResumeService, (service) => service.resume(input)),
  "thread.previewResumePlan": (input) =>
    Effect.flatMap(ThreadResumeService, (service) => service.preview(input)),
});
