import type { LegacyHistoryOrigin, LegacyHistorySection } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatDayAwareTimestamp } from "../../timestampFormat";

const LEGACY_HISTORY_PAGE_SIZE = 50;
const LARGE_BODY_PAGE_SIZE = 10;
const LARGE_BODY_SECTIONS: ReadonlySet<LegacyHistorySection> = new Set([
  "diffs",
  "events",
  "tools",
]);

/** Sections whose rows carry large blobs load in small pages. */
export function legacyHistoryPageSize(section: LegacyHistorySection): number {
  return LARGE_BODY_SECTIONS.has(section) ? LARGE_BODY_PAGE_SIZE : LEGACY_HISTORY_PAGE_SIZE;
}

/** Imported V1 rows are V1 history; a thread moved between V2 machines keeps an earlier copy. */
export function legacyHistoryTitle(origin: LegacyHistoryOrigin | undefined): string {
  return origin === "transfer" ? "Earlier copy" : "V1 history";
}

const SECTION_ORDER: ReadonlyArray<LegacyHistorySection> = [
  "messages",
  "turns",
  "diffs",
  "tools",
  "plans",
  "goals",
  "events",
  "thread",
  "provenance",
];

const SECTION_LABELS: Record<LegacyHistorySection, string> = {
  thread: "Thread",
  messages: "Messages",
  turns: "Checkpoints",
  diffs: "Diffs",
  tools: "Tools",
  plans: "Plans",
  goals: "Goals",
  events: "Events",
  provenance: "Provenance",
};

export function legacyHistorySectionLabel(section: LegacyHistorySection): string {
  return SECTION_LABELS[section];
}

/** Sections that hold rows, in reading order; any section the server adds later sorts last. */
export function orderLegacyHistorySections(
  sections: ReadonlyArray<LegacyHistorySection>,
): ReadonlyArray<LegacyHistorySection> {
  const rank = (section: LegacyHistorySection) => {
    const index = SECTION_ORDER.indexOf(section);
    return index === -1 ? SECTION_ORDER.length : index;
  };
  return [...new Set(sections)].toSorted((a, b) => rank(a) - rank(b));
}

export interface LegacyHistoryRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string | null;
  /** Raw stored timestamp; format it for display with `formatLegacyTimestamp`. */
  readonly at: string | null;
  readonly body: string | null;
}

type RawRecord = Readonly<Record<string, unknown>>;

const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** V1 rows arrive as snake_case table rows or camelCase bundle fields. */
function field(record: RawRecord, snakeName: string): unknown {
  const snake = record[snakeName];
  return snake !== undefined && snake !== null ? snake : record[camel(snakeName)];
}

function text(record: RawRecord, snakeName: string): string | null {
  const value = field(record, snakeName);
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pretty(value: unknown): string | null {
  const parsed = parseJson(value);
  if (parsed === undefined || parsed === null) return null;
  if (typeof parsed === "string") return parsed.length > 0 ? parsed : null;
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

/** V1 stored UTC; SQLite rows may omit the zone designator. */
export function formatLegacyTimestamp(
  value: string | null,
  timestampFormat: TimestampFormat,
  nowMs?: number,
): string | null {
  if (value === null) return null;
  const iso =
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value) && !/(Z|[+-]\d{2}:?\d{2})$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const formatted = formatDayAwareTimestamp(iso, timestampFormat, nowMs);
  return formatted.length > 0 ? formatted : value;
}

export type DiffLineTone = "add" | "remove" | "hunk" | null;

export function diffLineTone(line: string): DiffLineTone {
  if (line.startsWith("+++") || line.startsWith("---")) return null;
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return line.startsWith("@@") ? "hunk" : null;
}

/** Native transfer evidence stores turn items as `{type, toolName, input, output, text}`. */
function nativeToolBody(record: RawRecord): string | null {
  const input = pretty(record.input);
  const output = pretty(record.output ?? record.text);
  if (input !== null && output !== null) return `${input}\n\n${output}`;
  return input ?? output;
}

const joinDetail = (parts: ReadonlyArray<string | null>): string | null => {
  const present = parts.filter((part): part is string => part !== null);
  return present.length > 0 ? present.join(" · ") : null;
};

function checkpointFiles(record: RawRecord): ReadonlyArray<string> {
  const files = parseJson(field(record, "checkpoint_files_json") ?? record.files);
  if (!Array.isArray(files)) return [];
  return files.flatMap((file): string[] => {
    if (typeof file === "string") return [file];
    if (!isRecord(file)) return [];
    const path = text(file, "path");
    if (path === null) return [];
    const additions = file.additions;
    const deletions = file.deletions;
    const stat =
      typeof additions === "number" && typeof deletions === "number"
        ? ` +${additions} -${deletions}`
        : "";
    return [`${path}${stat}`];
  });
}

function goalRow(record: RawRecord, key: string): LegacyHistoryRow {
  const goal = parseJson(field(record, "goal_json") ?? record.goal);
  if (isRecord(goal)) {
    const objective = text(goal, "objective") ?? text(goal, "text") ?? text(goal, "title");
    return {
      key,
      label: "Goal",
      detail: joinDetail([text(goal, "status")]),
      at: text(goal, "updated_at") ?? text(goal, "created_at"),
      body: objective ?? pretty(goal),
    };
  }
  return { key, label: "Goal", detail: null, at: null, body: pretty(goal) };
}

function provenanceLabel(record: RawRecord): string {
  if (record.kind === "thread.forked") return "Forked";
  if (record.legacyBundleVersion !== undefined) return "V1 bundle";
  if (record.attachmentMap !== undefined) return "Attachment map";
  if (record.metadata !== undefined) return "Source metadata";
  if (record.sourceThread !== undefined || record.contextTransfers !== undefined) {
    return "Source thread";
  }
  return "Provenance";
}

/** Flattens one raw V1 record to the few fields a read-only row shows. */
export function describeLegacyRecord(
  section: LegacyHistorySection,
  record: RawRecord,
  index: number,
): LegacyHistoryRow {
  switch (section) {
    case "thread":
      return {
        key: text(record, "thread_id") ?? `thread-${index}`,
        label: text(record, "title") ?? "Thread",
        detail: joinDetail([text(record, "branch"), text(record, "worktree_path")]),
        at: text(record, "created_at"),
        body: null,
      };
    case "messages":
      return {
        key: text(record, "message_id") ?? `message-${index}`,
        label: text(record, "role") ?? "message",
        detail: field(record, "is_streaming") === true ? "streaming" : null,
        at: text(record, "created_at"),
        body: text(record, "text"),
      };
    case "turns": {
      const files = checkpointFiles(record);
      const turnCount = text(record, "checkpoint_turn_count");
      return {
        key: text(record, "turn_id") ?? `turn-${index}`,
        label: turnCount !== null ? `Checkpoint ${turnCount}` : "Turn",
        detail: joinDetail([
          text(record, "state"),
          text(record, "checkpoint_status"),
          text(record, "checkpoint_ref"),
          files.length > 0 ? `${files.length} files` : null,
        ]),
        at: text(record, "completed_at") ?? text(record, "requested_at"),
        body: files.length > 0 ? files.join("\n") : null,
      };
    }
    case "diffs": {
      const from = text(record, "from_turn_count");
      const to = text(record, "to_turn_count");
      return {
        key: `diff-${from ?? ""}-${to ?? ""}-${index}`,
        label: from !== null && to !== null ? `Turns ${from} to ${to}` : "Diff",
        detail: null,
        at: text(record, "created_at"),
        body: text(record, "diff"),
      };
    }
    case "tools":
      return {
        key: text(record, "activity_id") ?? text(record, "id") ?? `activity-${index}`,
        label:
          text(record, "summary") ??
          text(record, "toolName") ??
          text(record, "kind") ??
          text(record, "type") ??
          "Activity",
        detail: joinDetail([text(record, "kind") ?? text(record, "type"), text(record, "tone")]),
        at: text(record, "created_at"),
        body: pretty(field(record, "payload_json") ?? record.payload) ?? nativeToolBody(record),
      };
    case "plans":
      return {
        key: text(record, "plan_id") ?? `plan-${index}`,
        label: "Plan",
        detail: text(record, "implemented_at") !== null ? "implemented" : null,
        at: text(record, "updated_at") ?? text(record, "created_at"),
        body: text(record, "plan_markdown") ?? text(record, "markdown"),
      };
    case "goals":
      return goalRow(record, `goal-${index}`);
    case "events":
      return {
        key: text(record, "event_id") ?? `event-${index}`,
        label: text(record, "type") ?? text(record, "kind") ?? "Event",
        detail: null,
        at: text(record, "occurred_at") ?? text(record, "created_at"),
        body: pretty(record),
      };
    case "provenance":
      return {
        key: `provenance-${index}`,
        label: provenanceLabel(record),
        detail: null,
        at: null,
        body: pretty(record),
      };
  }
}
