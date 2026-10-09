// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalConsole:off

/** Arms only on a shutdown signal; remains active through uninterruptible finalizers. */
export function installShutdownDeadline(timeoutMs = 20_000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      process.stderr.write(
        `T3 shutdown deadline exceeded (${timeoutMs} ms); exiting for boot reconciliation.\n`,
      );
      process.exit(1);
    }, timeoutMs);
  };
  process.prependListener("SIGTERM", arm);
  process.prependListener("SIGINT", arm);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    process.removeListener("SIGTERM", arm);
    process.removeListener("SIGINT", arm);
  };
}
