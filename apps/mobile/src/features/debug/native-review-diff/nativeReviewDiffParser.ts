import {
  debugReviewDiffFixtures,
  type DebugReviewDiffFixture,
  type DebugReviewDiffFixtureId,
} from "../fixtures/reviewDiffFixtures";
import { computeWordAltDiffRanges } from "../../review/reviewWordDiffs";
import type { NativeReviewDiffRow } from "./nativeReviewDiffModule";

const NATIVE_REVIEW_MAX_WORD_DIFF_RANGE_COUNT = 4;
const NATIVE_REVIEW_MAX_WORD_DIFF_COVERAGE = 0.45;

export type NativeReviewDiffLanguage =
  | "bash"
  | "diff"
  | "javascript"
  | "json"
  | "jsx"
  | "tsx"
  | "typescript"
  | "yaml";

export interface NativeReviewDiffFile {
  readonly id: string;
  readonly path: string;
  readonly language: NativeReviewDiffLanguage;
  readonly additions: number;
  readonly deletions: number;
}

export interface NativeReviewDiffParsedFixture {
  readonly fixtureId: DebugReviewDiffFixtureId;
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly additions: number;
  readonly deletions: number;
}

interface NativeReviewDiffFileParseState {
  readonly path: string;
  readonly language: NativeReviewDiffLanguage;
  readonly additions: number;
  readonly deletions: number;
  readonly hasRenderableRows: boolean;
  readonly isBinary: boolean;
  readonly oldMode: string | null;
  readonly newMode: string | null;
}

function getDiffPathFromHeader(line: string): string {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match?.[2] ?? line.replace(/^diff --git /, "");
}

function getDiffPreviousPathFromHeader(line: string): string | null {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match?.[1] ?? null;
}

function parseDiffPath(line: string, prefix: "--- " | "+++ "): string | null {
  if (!line.startsWith(prefix)) {
    return null;
  }

  const rawPath = line.slice(prefix.length).trim();
  if (rawPath === "/dev/null") {
    return null;
  }

  return rawPath.replace(/^[ab]\//, "");
}

function resolveChangeType(input: {
  readonly previousPath: string | null;
  readonly nextPath: string | null;
}): NativeReviewDiffRow["changeType"] {
  if (!input.previousPath && input.nextPath) {
    return "new";
  }
  if (input.previousPath && !input.nextPath) {
    return "deleted";
  }
  if (input.previousPath && input.nextPath && input.previousPath !== input.nextPath) {
    return "renamed";
  }
  return "modified";
}

function resolveFileHeaderChangeType(input: {
  readonly previousPath: string | null | undefined;
  readonly nextPath: string | null | undefined;
  readonly currentChangeType: NativeReviewDiffRow["changeType"];
  readonly additions: number;
  readonly deletions: number;
}): NativeReviewDiffRow["changeType"] {
  if (input.currentChangeType === "new" || input.currentChangeType === "deleted") {
    return input.currentChangeType;
  }

  if (input.previousPath && input.nextPath && input.previousPath !== input.nextPath) {
    return input.additions + input.deletions === 0 ? "rename-pure" : "rename-changed";
  }

  return resolveChangeType({
    nextPath: input.nextPath ?? null,
    previousPath: input.previousPath ?? null,
  });
}

function getLanguageForPath(filePath: string): NativeReviewDiffLanguage {
  const normalizedPath = filePath.toLowerCase();
  if (normalizedPath.endsWith(".tsx")) return "tsx";
  if (normalizedPath.endsWith(".ts")) return "typescript";
  if (normalizedPath.endsWith(".jsx")) return "jsx";
  if (normalizedPath.endsWith(".js") || normalizedPath.endsWith(".cjs")) return "javascript";
  if (normalizedPath.endsWith(".json") || normalizedPath.endsWith(".jsonc")) return "json";
  if (normalizedPath.endsWith(".yml") || normalizedPath.endsWith(".yaml")) return "yaml";
  if (
    normalizedPath.endsWith(".sh") ||
    normalizedPath.includes("/bin/") ||
    normalizedPath.includes("shell")
  ) {
    return "bash";
  }
  return "diff";
}

function parseHunkLineNumbers(line: string): { oldLine: number; newLine: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) {
    return null;
  }
  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2]),
  };
}

function parseFileModeLine(line: string, prefix: "old mode " | "new mode "): string | null {
  if (!line.startsWith(prefix)) {
    return null;
  }

  return line.slice(prefix.length).trim() || null;
}

function createNoticeRow(input: {
  readonly fileId: string;
  readonly message: string;
  readonly suffix: string;
}): NativeReviewDiffRow {
  return {
    kind: "notice",
    id: `${input.fileId}:notice:${input.suffix}`,
    fileId: input.fileId,
    text: input.message,
  };
}

function getNoticeRowForFile(input: {
  readonly row: NativeReviewDiffRow;
  readonly file: NativeReviewDiffFileParseState | undefined;
}): NativeReviewDiffRow | null {
  const { file, row } = input;
  if (!file || row.kind !== "file" || !row.fileId) {
    return null;
  }

  if (file.isBinary) {
    return createNoticeRow({
      fileId: row.fileId,
      message: "Unsupported binary format. Diff contents are not available.",
      suffix: "binary",
    });
  }

  if (file.oldMode && file.newMode && file.oldMode !== file.newMode && !file.hasRenderableRows) {
    return createNoticeRow({
      fileId: row.fileId,
      message: `File mode changed from ${file.oldMode} to ${file.newMode}.`,
      suffix: "mode",
    });
  }

  if (row.changeType === "rename-pure" && !file.hasRenderableRows) {
    return createNoticeRow({
      fileId: row.fileId,
      message: "This file was renamed without modifications.",
      suffix: "rename",
    });
  }

  return null;
}

function isChangedLine(row: NativeReviewDiffRow | undefined, change: "add" | "delete") {
  return row?.kind === "line" && row.change === change && typeof row.content === "string";
}

function trimWordDiffRanges(
  content: string,
  ranges: NonNullable<NativeReviewDiffRow["wordDiffRanges"]>,
): NonNullable<NativeReviewDiffRow["wordDiffRanges"]> {
  return ranges.flatMap((range) => {
    let start = Math.max(0, range.start);
    let end = Math.min(content.length, range.end);

    while (start < end && /\s/.test(content[start] ?? "")) {
      start += 1;
    }

    while (end > start && /\s/.test(content[end - 1] ?? "")) {
      end -= 1;
    }

    return end > start ? [{ start, end }] : [];
  });
}

function nonWhitespaceLength(value: string) {
  return value.replace(/\s/g, "").length;
}

function getRangeCoverage(
  content: string,
  ranges: NonNullable<NativeReviewDiffRow["wordDiffRanges"]>,
) {
  const meaningfulLength = nonWhitespaceLength(content);
  if (meaningfulLength === 0) {
    return 1;
  }

  const highlightedLength = ranges.reduce(
    (total, range) => total + nonWhitespaceLength(content.slice(range.start, range.end)),
    0,
  );
  return highlightedLength / meaningfulLength;
}

function shouldUseWordDiffRanges(
  content: string,
  ranges: NonNullable<NativeReviewDiffRow["wordDiffRanges"]>,
) {
  if (ranges.length === 0 || ranges.length > NATIVE_REVIEW_MAX_WORD_DIFF_RANGE_COUNT) {
    return false;
  }

  return getRangeCoverage(content, ranges) <= NATIVE_REVIEW_MAX_WORD_DIFF_COVERAGE;
}

function addNativeWordDiffRanges(rows: ReadonlyArray<NativeReviewDiffRow>) {
  const nextRows = [...rows];
  let index = 0;

  while (index < nextRows.length) {
    const deletedRowIndexes: number[] = [];
    const addedRowIndexes: number[] = [];
    const fileId = nextRows[index]?.fileId;

    while (isChangedLine(nextRows[index], "delete") && nextRows[index]?.fileId === fileId) {
      deletedRowIndexes.push(index);
      index += 1;
    }

    if (deletedRowIndexes.length === 0) {
      index += 1;
      continue;
    }

    while (isChangedLine(nextRows[index], "add") && nextRows[index]?.fileId === fileId) {
      addedRowIndexes.push(index);
      index += 1;
    }

    if (addedRowIndexes.length === 0) {
      continue;
    }

    const pairCount = Math.min(deletedRowIndexes.length, addedRowIndexes.length);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const deletedRowIndex = deletedRowIndexes[pairIndex];
      const addedRowIndex = addedRowIndexes[pairIndex];
      const deletedRow = nextRows[deletedRowIndex];
      const addedRow = nextRows[addedRowIndex];
      if (!deletedRow?.content || !addedRow?.content) {
        continue;
      }

      const ranges = computeWordAltDiffRanges({
        deletionLine: deletedRow.content,
        additionLine: addedRow.content,
      });

      const deletionRanges = trimWordDiffRanges(deletedRow.content, ranges.deletion);
      const additionRanges = trimWordDiffRanges(addedRow.content, ranges.addition);

      if (shouldUseWordDiffRanges(deletedRow.content, deletionRanges)) {
        nextRows[deletedRowIndex] = { ...deletedRow, wordDiffRanges: deletionRanges };
      }

      if (shouldUseWordDiffRanges(addedRow.content, additionRanges)) {
        nextRows[addedRowIndex] = { ...addedRow, wordDiffRanges: additionRanges };
      }
    }
  }

  return nextRows;
}

export function parseNativeReviewDiffFixture(
  fixture: DebugReviewDiffFixture,
): NativeReviewDiffParsedFixture {
  const startedAt = performance.now();
  let rows: NativeReviewDiffRow[] = [];
  const files = new Map<string, NativeReviewDiffFileParseState>();
  const rawLines = fixture.diff.split(/\r?\n/);

  let currentFileId: string | null = null;
  let currentOldLine: number | null = null;
  let currentNewLine: number | null = null;

  function ensureCurrentFile(filePath: string, previousPath: string | null): string {
    const fileId = `file:${files.size}:${filePath}`;
    const language = getLanguageForPath(filePath);
    files.set(fileId, {
      path: filePath,
      language,
      additions: 0,
      deletions: 0,
      hasRenderableRows: false,
      isBinary: false,
      oldMode: null,
      newMode: null,
    });
    rows.push({
      kind: "file",
      id: `${fileId}:header`,
      fileId,
      filePath,
      previousPath,
      changeType: resolveChangeType({ nextPath: filePath, previousPath }),
      additions: 0,
      deletions: 0,
    });
    return fileId;
  }

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? "";

    if (rawLine.startsWith("diff --git ")) {
      currentFileId = ensureCurrentFile(
        getDiffPathFromHeader(rawLine),
        getDiffPreviousPathFromHeader(rawLine),
      );
      currentOldLine = null;
      currentNewLine = null;
      continue;
    }

    if (!currentFileId) {
      continue;
    }

    const previousPath = parseDiffPath(rawLine, "--- ");
    if (previousPath !== null || rawLine === "--- /dev/null") {
      rows = rows.map((row) =>
        row.id === `${currentFileId}:header`
          ? {
              ...row,
              previousPath,
              changeType: resolveChangeType({
                nextPath: row.filePath ?? null,
                previousPath,
              }),
            }
          : row,
      );
      continue;
    }

    const nextPath = parseDiffPath(rawLine, "+++ ");
    if (nextPath !== null || rawLine === "+++ /dev/null") {
      rows = rows.map((row) =>
        row.id === `${currentFileId}:header`
          ? {
              ...row,
              filePath: nextPath ?? row.filePath,
              changeType: resolveChangeType({
                nextPath,
                previousPath: row.previousPath ?? null,
              }),
            }
          : row,
      );
      continue;
    }

    const oldMode = parseFileModeLine(rawLine, "old mode ");
    if (oldMode !== null) {
      const file = files.get(currentFileId);
      if (file) {
        files.set(currentFileId, { ...file, oldMode });
      }
      continue;
    }

    const newMode = parseFileModeLine(rawLine, "new mode ");
    if (newMode !== null) {
      const file = files.get(currentFileId);
      if (file) {
        files.set(currentFileId, { ...file, newMode });
      }
      continue;
    }

    if (rawLine.startsWith("Binary files ")) {
      const file = files.get(currentFileId);
      if (file) {
        files.set(currentFileId, { ...file, isBinary: true });
      }
      continue;
    }

    if (rawLine.startsWith("@@ ")) {
      const file = files.get(currentFileId);
      if (file) {
        files.set(currentFileId, { ...file, hasRenderableRows: true });
      }
      const parsedLineNumbers = parseHunkLineNumbers(rawLine);
      currentOldLine = parsedLineNumbers?.oldLine ?? null;
      currentNewLine = parsedLineNumbers?.newLine ?? null;
      rows.push({
        kind: "hunk",
        id: `${currentFileId}:hunk:${index}`,
        fileId: currentFileId,
        text: rawLine,
      });
      continue;
    }

    const marker = rawLine[0];
    if (marker !== " " && marker !== "+" && marker !== "-") {
      continue;
    }

    const file = files.get(currentFileId);
    if (!file) {
      continue;
    }

    const change = marker === "+" ? "add" : marker === "-" ? "delete" : "context";
    rows.push({
      kind: "line",
      id: `${currentFileId}:line:${index}`,
      fileId: currentFileId,
      change,
      oldLineNumber: change === "add" ? null : currentOldLine,
      newLineNumber: change === "delete" ? null : currentNewLine,
      content: rawLine.slice(1),
    });

    if (change === "add") {
      files.set(currentFileId, { ...file, additions: file.additions + 1 });
      currentNewLine = currentNewLine === null ? null : currentNewLine + 1;
      continue;
    }

    if (change === "delete") {
      files.set(currentFileId, { ...file, deletions: file.deletions + 1 });
      currentOldLine = currentOldLine === null ? null : currentOldLine + 1;
      continue;
    }

    currentOldLine = currentOldLine === null ? null : currentOldLine + 1;
    currentNewLine = currentNewLine === null ? null : currentNewLine + 1;
  }

  rows = addNativeWordDiffRanges(rows);

  const fileSummaries = Array.from(files, ([id, file]) => ({
    id,
    path: file.path,
    language: file.language,
    additions: file.additions,
    deletions: file.deletions,
  }));
  const fileSummaryByPath = new Map(fileSummaries.map((file) => [file.path, file]));
  const rowsWithFileStats = rows.map((row): NativeReviewDiffRow => {
    if (row.kind !== "file" || !row.filePath) {
      return row;
    }
    const file = fileSummaryByPath.get(row.filePath);
    const additions = file?.additions ?? row.additions ?? 0;
    const deletions = file?.deletions ?? row.deletions ?? 0;
    return {
      kind: row.kind,
      id: row.id,
      fileId: row.fileId,
      filePath: row.filePath,
      previousPath: row.previousPath,
      changeType: resolveFileHeaderChangeType({
        previousPath: row.previousPath,
        nextPath: row.filePath,
        currentChangeType: row.changeType ?? "modified",
        additions,
        deletions,
      }),
      additions,
      deletions,
      text: row.text,
      content: row.content,
      change: row.change,
      oldLineNumber: row.oldLineNumber,
      newLineNumber: row.newLineNumber,
      wordDiffRanges: row.wordDiffRanges,
    };
  });
  const rowsWithFileNotices = rowsWithFileStats.flatMap((row): NativeReviewDiffRow[] => {
    const noticeRow = getNoticeRowForFile({
      row,
      file: row.fileId ? files.get(row.fileId) : undefined,
    });
    return noticeRow ? [row, noticeRow] : [row];
  });

  const parsed = {
    fixtureId: fixture.id,
    rows: rowsWithFileNotices,
    files: fileSummaries,
    additions: fileSummaries.reduce((total, file) => total + file.additions, 0),
    deletions: fileSummaries.reduce((total, file) => total + file.deletions, 0),
  };

  console.log("[debug-native-diff] parse", {
    durationMs: Math.round(performance.now() - startedAt),
    files: parsed.files.length,
    fixture: fixture.id,
    rows: parsed.rows.length,
  });

  return parsed;
}

export function getNativeReviewDiffFixture(fixtureId: DebugReviewDiffFixtureId) {
  return (
    debugReviewDiffFixtures.find((fixture) => fixture.id === fixtureId) ??
    debugReviewDiffFixtures[0]
  );
}
