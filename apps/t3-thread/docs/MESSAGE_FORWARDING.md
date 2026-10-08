# Forwarding a message

`t3-thread forward <target> --message <id>` forwards a message from the calling
thread. `--last-user` selects the last human-authored user message, excluding
agent handoffs and notifications. Outside a thread, pass `--source <thread>`.
Source and target accept saved names or raw thread UUIDs and can belong to
different paired environments. `--note` adds a routing note above the unchanged
source text. `--no-queue` rejects a busy recipient. Preserve the returned send
ID; resolve uncertain outcomes with `send-receipt <target> <send-id>` before an
explicit same-ID retry.

The source message stays unchanged. Missing, unsupported, or changed attachments
fail the whole forward. Attachment metadata, including screenshot capture data,
stays attached to the destination message. Cross-environment bytes stream one
attachment at a time through signed source downloads and normal target uploads.
Only the attachment stores contain attachment copies. The target allocates stable
thread-scoped IDs and sends through reliable handoff admission/receipts. Delivery
acceptance does not mean a provider turn has completed.

## RPC shape for the later UI action

1. On the source environment, `fork.message.forward.prepare` accepts
   `{threadId, selection: {type: "message", messageId}}` or
   `{threadId, selection: {type: "last-user"}}`. It returns a bundle containing
   source thread/message/project IDs, source title, author, exact text, and all
   attachment metadata. It never returns remote filesystem paths or base64 bodies.
2. For a remote target, for each attachment request `assets.createUrl` on the
   source, GET its signed URL, request `attachments.createUploadUrl` on the target,
   then POST exact bytes there. Preserve the original metadata and replace only
   its ID with the pending ID. Pass the ordered list as `stagedAttachments`.
   Omit this list for a local forward; pass an empty list for a remote text-only
   forward. Never replace attachment bytes with links or paths in message text.
3. On the target, `fork.message.forward.accept` accepts
   `{sendId, recipientThreadId, bundle, stagedAttachments?, sourceUrl, senderName,
note?, senderThreadId?, context?, coalesceKey: null, intent: "auto",
allowQueueFallback?: true}`. `sourceUrl` is the absolute original-message app
   URL. It returns the normal `HandoffReceipt` fields plus `forwardedMessage`
   (rendered text and normalized target attachment references). Store that exact
   message for a held retry through `fork.send.accept`, so source deletion or a
   pending-upload sweep cannot break delivery. Use `fork.send.lookup` for recovery.

The MCP equivalents are `t3_thread_forward_prepare` and `t3_thread_forward`.
MCP forwarding is limited to its own environment. Select `sourceThreadId`
(defaults to the caller) and `selection` (defaults to last human user), plus
`targetThreadId`, `sourceUrl`, `clientRequestId`, optional `note`, and optional
`queue`. An optional `targetEnvironmentId` makes the environment explicit.
A different environment returns the typed `cross_environment_forward_unsupported`
failure with the CLI path: `t3-thread forward <target> --message <id>` or
`--last-user`. Unknown local targets also name the CLI path for remote targets.
Permission ceilings and live calling-run ownership apply to target writes.

The app's web/desktop/mobile **Forward to...** action is a subsequent UI change.
