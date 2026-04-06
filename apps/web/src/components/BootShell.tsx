export function BootShell({
  eyebrow,
  title,
  copy,
  connectionLabel = "Opening WebSocket",
  latestEventLabel = "Pending",
}: {
  eyebrow: string;
  title: string;
  copy: string;
  connectionLabel?: string;
  latestEventLabel?: string;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-blue-500)_14%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-[1.75rem] border border-border/80 bg-card/92 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              {eyebrow}
            </p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          </div>

          <div className="rounded-2xl border border-border/70 bg-background/80 p-3 text-foreground shadow-sm">
            <div className="size-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
          </div>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy}</p>

        <div className="mt-5 grid gap-3 rounded-2xl border border-border/70 bg-background/60 p-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              Connection
            </p>
            <p className="mt-1 font-medium text-foreground">{connectionLabel}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              Latest Event
            </p>
            <p className="mt-1 font-medium text-foreground">{latestEventLabel}</p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <div className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground opacity-90">
            Reload app
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-2 text-xs font-medium text-muted-foreground">
          Show connection details
        </div>
      </section>
    </div>
  );
}
