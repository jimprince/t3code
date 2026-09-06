// On-demand host-wide process rows for recovery candidates outside T3's process
// tree (orphaned providers and diagnostic captures). Normal process diagnostics
// and signaling use upstream ResourceTelemetry; do not duplicate that service here.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number | null;
  readonly status: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly elapsed: string;
  readonly command: string;
}

const PROCESS_QUERY_TIMEOUT_MS = 1_000;
const POSIX_PROCESS_QUERY_COMMAND = "pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=";
const PROCESS_QUERY_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

class ProcessDiagnosticsQueryTimeoutError extends Schema.TaggedErrorClass<ProcessDiagnosticsQueryTimeoutError>()(
  "ProcessDiagnosticsQueryTimeoutError",
  {
    command: Schema.String,
    argCount: Schema.Number,
    cwd: Schema.String,
    timeoutMillis: Schema.Number,
  },
) {
  override get message(): string {
    return `Process diagnostics query '${this.command}' timed out after ${this.timeoutMillis}ms in '${this.cwd}'.`;
  }
}

class ProcessDiagnosticsQueryFailedError extends Schema.TaggedErrorClass<ProcessDiagnosticsQueryFailedError>()(
  "ProcessDiagnosticsQueryFailedError",
  {
    command: Schema.String,
    argCount: Schema.Number,
    cwd: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutBytes: Schema.optional(Schema.Number),
    stderrBytes: Schema.optional(Schema.Number),
    stdoutTruncated: Schema.optional(Schema.Boolean),
    stderrTruncated: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `Process diagnostics query '${this.command}' failed${exitCode} in '${this.cwd}'.`;
  }
}

const ProcessDiagnosticsError = Schema.Union([
  ProcessDiagnosticsQueryTimeoutError,
  ProcessDiagnosticsQueryFailedError,
]);
type ProcessDiagnosticsError = typeof ProcessDiagnosticsError.Type;
const isProcessDiagnosticsError = Schema.is(ProcessDiagnosticsError);

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePosixProcessRows(output: string): ReadonlyArray<ProcessRow> {
  const rows: ProcessRow[] = [];
  const rowPattern =
    /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+([+-]?(?:\d+\.?\d*|\.\d+))\s+(\d+)\s+(\S+)\s+(.+)$/;

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    const match = rowPattern.exec(line);
    if (!match) continue;

    const pidText = match[1];
    const ppidText = match[2];
    const pgidText = match[3];
    const status = match[4];
    const cpuText = match[5];
    const rssText = match[6];
    const elapsed = match[7];
    const command = match[8];
    if (
      pidText === undefined ||
      ppidText === undefined ||
      pgidText === undefined ||
      status === undefined ||
      cpuText === undefined ||
      rssText === undefined ||
      elapsed === undefined ||
      command === undefined
    ) {
      continue;
    }

    const pid = parsePositiveInt(pidText);
    const ppid = parseNonNegativeInt(ppidText);
    const pgid = Number.parseInt(pgidText, 10);
    const cpuPercent = parseNumber(cpuText);
    const rssKiB = parseNonNegativeInt(rssText);
    if (
      pid === null ||
      ppid === null ||
      !Number.isInteger(pgid) ||
      cpuPercent === null ||
      rssKiB === null ||
      !status ||
      !elapsed ||
      !command
    ) {
      continue;
    }

    rows.push({
      pid,
      ppid,
      pgid,
      status,
      cpuPercent,
      rssBytes: rssKiB * 1024,
      elapsed,
      command,
    });
  }

  return rows;
}

function normalizeWindowsProcessRow(value: unknown): ProcessRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const pid = typeof record.ProcessId === "number" ? record.ProcessId : null;
  const ppid = typeof record.ParentProcessId === "number" ? record.ParentProcessId : null;
  const commandLine =
    typeof record.CommandLine === "string" && record.CommandLine.trim().length > 0
      ? record.CommandLine
      : typeof record.Name === "string"
        ? record.Name
        : null;
  const workingSet =
    typeof record.WorkingSetSize === "number" && Number.isFinite(record.WorkingSetSize)
      ? Math.max(0, Math.round(record.WorkingSetSize))
      : 0;
  const cpuPercent =
    typeof record.PercentProcessorTime === "number" && Number.isFinite(record.PercentProcessorTime)
      ? Math.max(0, record.PercentProcessorTime)
      : 0;

  if (!pid || pid <= 0 || ppid === null || ppid < 0 || !commandLine) return null;
  return {
    pid,
    ppid,
    pgid: null,
    status: typeof record.Status === "string" && record.Status.length > 0 ? record.Status : "Live",
    cpuPercent,
    rssBytes: workingSet,
    elapsed: "",
    command: commandLine,
  };
}

function parseWindowsProcessRows(output: string): ReadonlyArray<ProcessRow> {
  if (output.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((record) => {
      const row = normalizeWindowsProcessRow(record);
      return row ? [row] : [];
    });
  } catch {
    return [];
  }
}

interface ProcessOutput {
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderr: string;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
}

const runProcess = Effect.fn("runProcess")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}) {
  const cwd = process.cwd();
  return yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // `ps` and `powershell.exe` are real executables; spawning through cmd.exe
    // shell mode would re-tokenize the PowerShell `-Command` payload (which
    // contains pipes) before PowerShell ever sees it.
    const child = yield* spawner.spawn(
      ChildProcess.make(input.command, input.args, {
        cwd,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({
          stream: child.stdout,
          maxBytes: PROCESS_QUERY_MAX_OUTPUT_BYTES,
          truncatedMarker: "\n\n[truncated]",
        }),
        collectUint8StreamText({
          stream: child.stderr,
          maxBytes: PROCESS_QUERY_MAX_OUTPUT_BYTES,
          truncatedMarker: "\n\n[truncated]",
        }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );

    return {
      cwd,
      exitCode,
      stdout: stdout.text,
      stdoutBytes: stdout.bytes,
      stdoutTruncated: stdout.truncated,
      stderr: stderr.text,
      stderrBytes: stderr.bytes,
      stderrTruncated: stderr.truncated,
    } satisfies ProcessOutput;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(PROCESS_QUERY_TIMEOUT_MS)),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(
            new ProcessDiagnosticsQueryTimeoutError({
              command: input.command,
              argCount: input.args.length,
              cwd,
              timeoutMillis: PROCESS_QUERY_TIMEOUT_MS,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.mapError((cause) =>
      isProcessDiagnosticsError(cause)
        ? cause
        : new ProcessDiagnosticsQueryFailedError({
            command: input.command,
            argCount: input.args.length,
            cwd,
            cause,
          }),
    ),
  );
});

function readPosixProcessRows(): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return runProcess({
    command: "ps",
    args: ["-axo", POSIX_PROCESS_QUERY_COMMAND],
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            new ProcessDiagnosticsQueryFailedError({
              command: "ps",
              argCount: 2,
              cwd: result.cwd,
              exitCode: result.exitCode,
              stdoutBytes: result.stdoutBytes,
              stderrBytes: result.stderrBytes,
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
            }),
          )
        : Effect.succeed(parsePosixProcessRows(result.stdout)),
    ),
  );
}

function readWindowsProcessRows(): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const command = [
    "$processes = Get-CimInstance Win32_Process | ForEach-Object {",
    '$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess = $($_.ProcessId)" -ErrorAction SilentlyContinue;',
    "[pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; Status = $_.Status; WorkingSetSize = $_.WorkingSetSize; PercentProcessorTime = if ($perf) { $perf.PercentProcessorTime } else { 0 } }",
    "};",
    "$processes | ConvertTo-Json -Compress -Depth 3",
  ].join(" ");

  return runProcess({
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", command],
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            new ProcessDiagnosticsQueryFailedError({
              command: "powershell.exe",
              argCount: 4,
              cwd: result.cwd,
              exitCode: result.exitCode,
              stdoutBytes: result.stdoutBytes,
              stderrBytes: result.stderrBytes,
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
            }),
          )
        : Effect.succeed(parseWindowsProcessRows(result.stdout)),
    ),
  );
}

export const readProcessRows = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return yield* platform === "win32" ? readWindowsProcessRows() : readPosixProcessRows();
});
