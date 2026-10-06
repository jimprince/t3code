/** A live run owns its outcome; a stopped session from an earlier run cannot fail it. */
export function unboundRunOutcome(input: {
  readonly messageCreatedAt: string;
  readonly run: { readonly status: string; readonly requestedAt: string } | null;
  readonly session: {
    readonly status: string;
    readonly updatedAt: string;
    readonly lastError: string | null;
  } | null;
}): { readonly status: "completed" | "failed"; readonly result: string } | null {
  const sent = Date.parse(input.messageCreatedAt);
  const run = input.run;
  if (run) {
    if (["queued", "preparing", "starting", "running", "waiting"].includes(run.status)) return null;
    if (run.status === "completed") return { status: "completed", result: "Turn completed." };
    const state =
      run.status === "failed"
        ? "error"
        : ["cancelled", "rolled_back"].includes(run.status)
          ? "interrupted"
          : run.status;
    return { status: "failed", result: `Turn ${state}.` };
  }
  const session = input.session;
  if (
    session &&
    ["error", "stopped"].includes(session.status) &&
    Date.parse(session.updatedAt) >= sent
  )
    return {
      status: "failed",
      result: session.lastError ?? "Provider session stopped before completion.",
    };
  return null;
}
