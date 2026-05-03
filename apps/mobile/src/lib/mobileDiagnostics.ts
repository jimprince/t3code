import { uuidv4 } from "./uuid";

export type MobileDiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface MobileDiagnosticEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly level: MobileDiagnosticLevel;
  readonly tag: string;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

const DEFAULT_DIAGNOSTIC_LIMIT = 300;
const DIAGNOSTIC_SNAPSHOT_FILE = "t3-mobile-debug-snapshot.json";
const diagnostics: MobileDiagnosticEvent[] = [];

const SECRET_KEY_PATTERN = /(token|credential|authorization|secret|password|bearer|wstoken)/i;
const URL_KEY_PATTERN = /(url|origin|baseurl|endpoint)/i;

function shouldMirrorDiagnostics(): boolean {
  return Boolean(typeof __DEV__ !== "undefined" ? __DEV__ : false);
}

function redactUrlValue(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function redactMobileDiagnosticValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) {
    if (typeof value === "string") {
      return value.trim().length > 0 ? "[redacted-present]" : "[redacted-empty]";
    }
    return value == null ? value : "[redacted]";
  }

  if (typeof value === "string" && URL_KEY_PATTERN.test(key)) {
    return redactUrlValue(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => redactMobileDiagnosticValue(`${key}.${index}`, entry));
  }

  if (value && typeof value === "object") {
    return redactMobileDiagnosticData(value as Record<string, unknown>);
  }

  return value;
}

export function redactMobileDiagnosticData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, redactMobileDiagnosticValue(key, value)]),
  );
}

function mirrorDiagnostic(event: MobileDiagnosticEvent): void {
  if (!shouldMirrorDiagnostics()) {
    return;
  }

  const payload = event.data ? { tag: event.tag, ...event.data } : { tag: event.tag };
  switch (event.level) {
    case "error":
      console.error("[mobile-diagnostics]", event.message ?? event.tag, payload);
      break;
    case "warn":
      console.warn("[mobile-diagnostics]", event.message ?? event.tag, payload);
      break;
    default:
      console.log("[mobile-diagnostics]", event.message ?? event.tag, payload);
      break;
  }
}

export function recordMobileDiagnostic(
  event: Omit<MobileDiagnosticEvent, "id" | "timestamp">,
): void {
  const next: MobileDiagnosticEvent = {
    ...event,
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    ...(event.data ? { data: redactMobileDiagnosticData(event.data) } : {}),
  };

  diagnostics.push(next);
  if (diagnostics.length > DEFAULT_DIAGNOSTIC_LIMIT) {
    diagnostics.splice(0, diagnostics.length - DEFAULT_DIAGNOSTIC_LIMIT);
  }
  mirrorDiagnostic(next);
}

export function getMobileDiagnosticTail(limit = DEFAULT_DIAGNOSTIC_LIMIT): MobileDiagnosticEvent[] {
  return diagnostics.slice(Math.max(0, diagnostics.length - limit));
}

export function clearMobileDiagnostics(): void {
  diagnostics.splice(0, diagnostics.length);
}

export async function writeMobileDiagnosticsSnapshot(extra?: object): Promise<string> {
  const { File, Paths } = await import("expo-file-system");
  const file = new File(Paths.document, DIAGNOSTIC_SNAPSHOT_FILE);
  if (!file.exists) {
    file.create({ intermediates: true, overwrite: true });
  }
  file.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        diagnosticsTail: getMobileDiagnosticTail(),
        ...(extra && typeof extra === "object" ? extra : {}),
      },
      null,
      2,
    )}\n`,
  );
  return file.uri;
}

export const MOBILE_DIAGNOSTIC_SNAPSHOT_FILE = DIAGNOSTIC_SNAPSHOT_FILE;
