import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bashLanguage from "@shikijs/langs/bash";
import diffLanguage from "@shikijs/langs/diff";
import javascriptLanguage from "@shikijs/langs/javascript";
import jsonLanguage from "@shikijs/langs/json";
import jsxLanguage from "@shikijs/langs/jsx";
import tsxLanguage from "@shikijs/langs/tsx";
import typescriptLanguage from "@shikijs/langs/typescript";
import yamlLanguage from "@shikijs/langs/yaml";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";
import Stack from "expo-router/stack";
import {
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Animated,
  FlatList,
  PanResponder,
  Pressable,
  ScrollView,
  Text as NativeText,
  type ListRenderItemInfo,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import {
  debugReviewDiffFixtures,
  type DebugReviewDiffFixture,
  type DebugReviewDiffFixtureId,
} from "../../features/debug/fixtures/reviewDiffFixtures";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

type DebugHighlightEngine = "native" | "javascript";
type DebugDiffChange = "context" | "add" | "delete";
type DebugDiffLanguage =
  | "bash"
  | "diff"
  | "javascript"
  | "json"
  | "jsx"
  | "tsx"
  | "typescript"
  | "yaml";

type DebugToken = {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
};

type DebugDiffFile = {
  readonly id: string;
  readonly path: string;
  readonly language: DebugDiffLanguage;
  readonly additions: number;
  readonly deletions: number;
};

type DebugDiffFileHeaderRow = {
  readonly kind: "file";
  readonly id: string;
  readonly fileId: string;
  readonly filePath: string;
  readonly language: DebugDiffLanguage;
  readonly additions: number;
  readonly deletions: number;
};

type DebugDiffHunkRow = {
  readonly kind: "hunk";
  readonly id: string;
  readonly fileId: string;
  readonly text: string;
};

type DebugDiffCodeRow = {
  readonly kind: "line";
  readonly id: string;
  readonly fileId: string;
  readonly change: DebugDiffChange;
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly content: string;
  readonly highlightChunkId: string;
  readonly indexInHighlightChunk: number;
};

type DebugDiffRow = DebugDiffFileHeaderRow | DebugDiffHunkRow | DebugDiffCodeRow;

type DebugHighlightChunk = {
  readonly id: string;
  readonly fileId: string;
  readonly language: DebugDiffLanguage;
  readonly rows: ReadonlyArray<DebugDiffCodeRow>;
};

type DebugParsedDiff = {
  readonly files: ReadonlyArray<DebugDiffFile>;
  readonly rows: ReadonlyArray<DebugDiffRow>;
  readonly highlightChunks: ReadonlyArray<DebugHighlightChunk>;
  readonly additions: number;
  readonly deletions: number;
};

type DebugHighlighterHandle = {
  readonly engine: DebugHighlightEngine;
  readonly tokenize: (
    code: string,
    options: { readonly lang: DebugDiffLanguage; readonly theme: string },
  ) => ReadonlyArray<ReadonlyArray<DebugToken>>;
};

const DEBUG_HIGHLIGHT_CHUNK_SIZE = 500;
const DEBUG_DIFF_ROW_HEIGHT = 28;
const DEBUG_CHANGE_BAR_WIDTH = 4;
const DEBUG_GUTTER_WIDTH = 58;
const DEBUG_STICKY_WIDTH = DEBUG_CHANGE_BAR_WIDTH + DEBUG_GUTTER_WIDTH;
const DEBUG_CONTENT_WIDTH = 3_000;
const DEBUG_DELETE_STRIPE_COUNT = DEBUG_DIFF_ROW_HEIGHT / 2;
const DEBUG_MONO_FONT_FAMILY = "BerkeleyMono-Regular";
const DEBUG_CODE_TEXT_STYLE = {
  fontFamily: DEBUG_MONO_FONT_FAMILY,
  fontStyle: "normal" as const,
  fontWeight: "700" as const,
};
const DEBUG_DELETE_STRIPE_INDICES = Array.from(
  { length: DEBUG_DELETE_STRIPE_COUNT },
  (_, index) => index,
);
const DEBUG_THEME_NAME_BY_SCHEME = {
  dark: "github-dark-default",
  light: "github-light-default",
} as const;

const DEBUG_LANGUAGES = [
  bashLanguage,
  diffLanguage,
  javascriptLanguage,
  jsonLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
  yamlLanguage,
] satisfies Parameters<typeof createHighlighterCore>[0]["langs"];

let nativeHighlighterPromise: Promise<DebugHighlighterHandle> | null = null;
let javascriptHighlighterPromise: Promise<DebugHighlighterHandle> | null = null;

class DebugTokenStore {
  private readonly fileVersions = new Map<string, number>();
  private readonly listenersByFileId = new Map<string, Set<() => void>>();
  private resetVersion = 0;
  private readonly tokensByChunkId = new Map<string, ReadonlyArray<ReadonlyArray<DebugToken>>>();

  getFileVersion(fileId: string): string {
    return `${this.resetVersion}:${this.fileVersions.get(fileId) ?? 0}`;
  }

  getTokens(chunkId: string): ReadonlyArray<ReadonlyArray<DebugToken>> | null {
    return this.tokensByChunkId.get(chunkId) ?? null;
  }

  reset(): void {
    this.tokensByChunkId.clear();
    this.fileVersions.clear();
    this.resetVersion += 1;
    this.listenersByFileId.forEach((listeners) => {
      listeners.forEach((listener) => listener());
    });
  }

  setChunk(chunk: DebugHighlightChunk, tokens: ReadonlyArray<ReadonlyArray<DebugToken>>): void {
    this.tokensByChunkId.set(chunk.id, tokens);
    this.fileVersions.set(chunk.fileId, (this.fileVersions.get(chunk.fileId) ?? 0) + 1);
    this.listenersByFileId.get(chunk.fileId)?.forEach((listener) => listener());
  }

  subscribeFile(fileId: string, listener: () => void): () => void {
    let listeners = this.listenersByFileId.get(fileId);
    if (!listeners) {
      listeners = new Set();
      this.listenersByFileId.set(fileId, listeners);
    }

    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.listenersByFileId.delete(fileId);
      }
    };
  }
}

class DebugHorizontalOffsetStore {
  private readonly offsetsByFileId = new Map<string, number>();
  private readonly valuesByFileId = new Map<string, Animated.Value>();

  getOffset(fileId: string): number {
    return this.offsetsByFileId.get(fileId) ?? 0;
  }

  getValue(fileId: string): Animated.Value {
    let value = this.valuesByFileId.get(fileId);
    if (!value) {
      value = new Animated.Value(-this.getOffset(fileId));
      this.valuesByFileId.set(fileId, value);
    }
    return value;
  }

  reset(): void {
    this.valuesByFileId.forEach((value) => value.stopAnimation());
    this.valuesByFileId.clear();
    this.offsetsByFileId.clear();
  }

  setOffset(fileId: string, offset: number): void {
    this.offsetsByFileId.set(fileId, offset);
    this.getValue(fileId).setValue(-offset);
  }
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function normalizeTokens(
  tokenLines: ReadonlyArray<ReadonlyArray<{ content: string; color?: string; fontStyle?: number }>>,
): ReadonlyArray<ReadonlyArray<DebugToken>> {
  return tokenLines.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

async function createNativeDebugHighlighter(): Promise<DebugHighlighterHandle> {
  const nativeEngineModule = await import("react-native-shiki-engine");
  if (!nativeEngineModule.isNativeEngineAvailable()) {
    throw new Error("Native Shiki engine is not available in this build.");
  }

  const highlighter = await createHighlighterCore({
    langs: DEBUG_LANGUAGES,
    themes: [githubLightDefault, githubDarkDefault],
    engine: nativeEngineModule.createNativeEngine(),
  });

  return {
    engine: "native",
    tokenize: (code, options) => normalizeTokens(highlighter.codeToTokensBase(code, options)),
  };
}

async function createJavascriptDebugHighlighter(): Promise<DebugHighlighterHandle> {
  const highlighter: HighlighterCore = await createHighlighterCore({
    langs: DEBUG_LANGUAGES,
    themes: [githubLightDefault, githubDarkDefault],
    engine: createJavaScriptRegexEngine(),
  });

  return {
    engine: "javascript",
    tokenize: (code, options) => normalizeTokens(highlighter.codeToTokensBase(code, options)),
  };
}

async function getDebugHighlighter(engine: DebugHighlightEngine): Promise<DebugHighlighterHandle> {
  if (engine === "native") {
    nativeHighlighterPromise ??= createNativeDebugHighlighter();
    return nativeHighlighterPromise;
  }

  javascriptHighlighterPromise ??= createJavascriptDebugHighlighter();
  return javascriptHighlighterPromise;
}

function getDiffPathFromHeader(line: string): string {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match?.[2] ?? line.replace(/^diff --git /, "");
}

function getLanguageForPath(filePath: string): DebugDiffLanguage {
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

function makeChunkId(fileId: string, chunkIndex: number): string {
  return `${fileId}:chunk:${chunkIndex}`;
}

function parseDebugDiffFixture(fixture: DebugReviewDiffFixture): DebugParsedDiff {
  const startedAt = performance.now();
  const rows: DebugDiffRow[] = [];
  const files = new Map<
    string,
    { path: string; language: DebugDiffLanguage; additions: number; deletions: number }
  >();
  const fileLineRows = new Map<string, DebugDiffCodeRow[]>();
  const rawLines = fixture.diff.split(/\r?\n/);

  let currentFileId: string | null = null;
  let currentOldLine: number | null = null;
  let currentNewLine: number | null = null;

  function ensureCurrentFile(filePath: string): string {
    const fileId = `file:${files.size}:${filePath}`;
    files.set(fileId, {
      path: filePath,
      language: getLanguageForPath(filePath),
      additions: 0,
      deletions: 0,
    });
    fileLineRows.set(fileId, []);
    rows.push({
      kind: "file",
      id: `${fileId}:header`,
      fileId,
      filePath,
      language: getLanguageForPath(filePath),
      additions: 0,
      deletions: 0,
    });
    return fileId;
  }

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? "";
    if (rawLine.startsWith("diff --git ")) {
      currentFileId = ensureCurrentFile(getDiffPathFromHeader(rawLine));
      currentOldLine = null;
      currentNewLine = null;
      continue;
    }

    if (!currentFileId) {
      continue;
    }

    if (rawLine.startsWith("@@ ")) {
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

    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) {
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

    const change: DebugDiffChange = marker === "+" ? "add" : marker === "-" ? "delete" : "context";
    const oldLineNumber = change === "add" ? null : currentOldLine;
    const newLineNumber = change === "delete" ? null : currentNewLine;
    const lineRows = fileLineRows.get(currentFileId) ?? [];
    const chunkIndex = Math.floor(lineRows.length / DEBUG_HIGHLIGHT_CHUNK_SIZE);
    const codeRow: DebugDiffCodeRow = {
      kind: "line",
      id: `${currentFileId}:line:${index}`,
      fileId: currentFileId,
      change,
      oldLineNumber,
      newLineNumber,
      content: rawLine.slice(1),
      highlightChunkId: makeChunkId(currentFileId, chunkIndex),
      indexInHighlightChunk: lineRows.length % DEBUG_HIGHLIGHT_CHUNK_SIZE,
    };

    rows.push(codeRow);
    lineRows.push(codeRow);
    fileLineRows.set(currentFileId, lineRows);

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

  const fileSummaries = Array.from(files, ([id, file]) => ({ id, ...file }));
  const fileSummaryById = new Map(fileSummaries.map((file) => [file.id, file]));
  const rowsWithFileStats = rows.map((row): DebugDiffRow => {
    if (row.kind !== "file") {
      return row;
    }
    const file = fileSummaryById.get(row.fileId);
    return {
      kind: row.kind,
      id: row.id,
      fileId: row.fileId,
      filePath: row.filePath,
      language: row.language,
      additions: file?.additions ?? row.additions,
      deletions: file?.deletions ?? row.deletions,
    };
  });
  const highlightChunks: DebugHighlightChunk[] = [];
  fileLineRows.forEach((lineRows, fileId) => {
    const file = fileSummaryById.get(fileId);
    if (!file) {
      return;
    }
    for (
      let startIndex = 0;
      startIndex < lineRows.length;
      startIndex += DEBUG_HIGHLIGHT_CHUNK_SIZE
    ) {
      const chunkIndex = startIndex / DEBUG_HIGHLIGHT_CHUNK_SIZE;
      highlightChunks.push({
        id: makeChunkId(fileId, chunkIndex),
        fileId,
        language: file.language,
        rows: lineRows.slice(startIndex, startIndex + DEBUG_HIGHLIGHT_CHUNK_SIZE),
      });
    }
  });

  const parsed = {
    files: fileSummaries,
    rows: rowsWithFileStats,
    highlightChunks,
    additions: fileSummaries.reduce((total, file) => total + file.additions, 0),
    deletions: fileSummaries.reduce((total, file) => total + file.deletions, 0),
  };

  console.log("[debug-diff-scratch] parse", {
    durationMs: Math.round(performance.now() - startedAt),
    fixture: fixture.id,
    files: parsed.files.length,
    highlightChunks: parsed.highlightChunks.length,
    rows: parsed.rows.length,
  });

  return parsed;
}

const TokenText = memo(function TokenText(props: {
  readonly content: string;
  readonly tokens: ReadonlyArray<DebugToken> | null;
}) {
  if (!props.tokens) {
    return (
      <NativeText
        numberOfLines={1}
        className="text-[13px] leading-[18px] text-foreground"
        style={DEBUG_CODE_TEXT_STYLE}
      >
        {props.content || " "}
      </NativeText>
    );
  }

  let tokenOffset = 0;

  return (
    <NativeText
      numberOfLines={1}
      className="text-[13px] leading-[18px] text-foreground"
      style={DEBUG_CODE_TEXT_STYLE}
    >
      {props.tokens.map((token) => {
        const tokenKey = `${tokenOffset}:${token.content.length}:${token.color ?? ""}:${token.fontStyle ?? ""}`;
        tokenOffset += token.content.length;

        return (
          <NativeText
            key={tokenKey}
            style={{
              ...DEBUG_CODE_TEXT_STYLE,
              color: token.color ?? undefined,
            }}
          >
            {token.content}
          </NativeText>
        );
      })}
    </NativeText>
  );
});

function changeRowClassName(change: DebugDiffChange): string {
  if (change === "add") return "bg-emerald-500/10";
  if (change === "delete") return "bg-rose-500/10";
  return "bg-card";
}

const DebugChangeBar = memo(function DebugChangeBar(props: { readonly change: DebugDiffChange }) {
  if (props.change === "delete") {
    return (
      <View className="overflow-hidden" style={{ width: DEBUG_CHANGE_BAR_WIDTH }}>
        {DEBUG_DELETE_STRIPE_INDICES.map((index) => (
          <View key={index}>
            <View className="bg-rose-400" style={{ height: 1, width: DEBUG_CHANGE_BAR_WIDTH }} />
            <View style={{ height: 1, width: DEBUG_CHANGE_BAR_WIDTH }} />
          </View>
        ))}
      </View>
    );
  }

  if (props.change === "add") {
    return <View className="bg-emerald-400" style={{ width: DEBUG_CHANGE_BAR_WIDTH }} />;
  }

  return <View style={{ width: DEBUG_CHANGE_BAR_WIDTH }} />;
});

const DebugDiffFileHeader = memo(function DebugDiffFileHeader(props: {
  readonly header: DebugDiffFileHeaderRow;
  readonly width: number;
}) {
  return (
    <View
      className="flex-row items-center border-b border-border bg-card px-3"
      style={{ height: DEBUG_DIFF_ROW_HEIGHT, width: props.width }}
    >
      <Text className="min-w-0 flex-1 text-[13px] font-t3-bold text-foreground" numberOfLines={1}>
        {props.header.filePath}
      </Text>
      <Text className="ml-2 text-[12px] font-t3-bold text-rose-500">-{props.header.deletions}</Text>
      <Text className="ml-2 text-[12px] font-t3-bold text-emerald-500">
        +{props.header.additions}
      </Text>
    </View>
  );
});

const DebugDiffStickyCell = memo(function DebugDiffStickyCell(props: {
  readonly item: DebugDiffHunkRow | DebugDiffCodeRow;
}) {
  if (props.item.kind === "hunk") {
    return (
      <View
        className="border-b border-sky-500/10 bg-sky-500/12"
        style={{ height: DEBUG_DIFF_ROW_HEIGHT, width: DEBUG_STICKY_WIDTH }}
      />
    );
  }

  const displayLineNumber = props.item.newLineNumber ?? props.item.oldLineNumber ?? "";

  return (
    <View
      className={cn("flex-row", changeRowClassName(props.item.change))}
      style={{ height: DEBUG_DIFF_ROW_HEIGHT, width: DEBUG_STICKY_WIDTH }}
    >
      <DebugChangeBar change={props.item.change} />
      <View className="items-end justify-center pr-2" style={{ width: DEBUG_GUTTER_WIDTH }}>
        <NativeText
          className="text-[11px] text-foreground-muted"
          numberOfLines={1}
          style={DEBUG_CODE_TEXT_STYLE}
        >
          {displayLineNumber}
        </NativeText>
      </View>
    </View>
  );
});

const DebugDiffCodeCell = memo(function DebugDiffCodeCell(props: {
  readonly item: DebugDiffHunkRow | DebugDiffCodeRow;
  readonly tokens: ReadonlyArray<DebugToken> | null;
}) {
  const { item } = props;

  if (item.kind === "hunk") {
    return (
      <View
        className="justify-center border-b border-sky-500/10 bg-sky-500/12 px-2"
        style={{ height: DEBUG_DIFF_ROW_HEIGHT, width: DEBUG_CONTENT_WIDTH }}
      >
        <NativeText
          numberOfLines={1}
          className="text-[13px] leading-[18px] text-sky-700 dark:text-sky-300"
          style={DEBUG_CODE_TEXT_STYLE}
        >
          {item.text}
        </NativeText>
      </View>
    );
  }

  return (
    <View
      className={cn("justify-center px-2", changeRowClassName(item.change))}
      style={{ height: DEBUG_DIFF_ROW_HEIGHT, width: DEBUG_CONTENT_WIDTH }}
    >
      <TokenText content={item.content} tokens={props.tokens} />
    </View>
  );
});

const DebugHorizontalCodeViewport = memo(function DebugHorizontalCodeViewport(props: {
  readonly children: ReactElement;
  readonly fileId: string;
  readonly horizontalOffset: Animated.Value;
  readonly onActivateFile: (fileId: string) => void;
  readonly viewportWidth: number;
}) {
  return (
    <View
      onTouchStart={() => props.onActivateFile(props.fileId)}
      style={{ overflow: "hidden", width: props.viewportWidth }}
    >
      <Animated.View style={{ transform: [{ translateX: props.horizontalOffset }] }}>
        {props.children}
      </Animated.View>
    </View>
  );
});

const DebugDiffLineRowView = memo(function DebugDiffLineRowView(props: {
  readonly horizontalOffset: Animated.Value;
  readonly onActivateFile: (fileId: string) => void;
  readonly row: DebugDiffCodeRow;
  readonly tokenStore: DebugTokenStore;
  readonly viewportWidth: number;
}) {
  useSyncExternalStore(
    useCallback(
      (listener) => props.tokenStore.subscribeFile(props.row.fileId, listener),
      [props.row.fileId, props.tokenStore],
    ),
    useCallback(
      () => props.tokenStore.getFileVersion(props.row.fileId),
      [props.row.fileId, props.tokenStore],
    ),
    useCallback(
      () => props.tokenStore.getFileVersion(props.row.fileId),
      [props.row.fileId, props.tokenStore],
    ),
  );

  return (
    <View className="flex-row" style={{ height: DEBUG_DIFF_ROW_HEIGHT }}>
      <DebugDiffStickyCell item={props.row} />
      <DebugHorizontalCodeViewport
        fileId={props.row.fileId}
        horizontalOffset={props.horizontalOffset}
        onActivateFile={props.onActivateFile}
        viewportWidth={props.viewportWidth}
      >
        <DebugDiffCodeCell
          item={props.row}
          tokens={
            props.tokenStore.getTokens(props.row.highlightChunkId)?.[
              props.row.indexInHighlightChunk
            ] ?? null
          }
        />
      </DebugHorizontalCodeViewport>
    </View>
  );
});

const DebugDiffFlatRowView = memo(function DebugDiffFlatRowView(props: {
  readonly horizontalOffsetStore: DebugHorizontalOffsetStore;
  readonly onActivateFile: (fileId: string) => void;
  readonly row: DebugDiffRow;
  readonly tokenStore: DebugTokenStore;
  readonly width: number;
}) {
  if (props.row.kind === "file") {
    return <DebugDiffFileHeader header={props.row} width={props.width} />;
  }

  const viewportWidth = Math.max(0, props.width - DEBUG_STICKY_WIDTH);

  if (props.row.kind === "hunk") {
    const horizontalOffset = props.horizontalOffsetStore.getValue(props.row.fileId);
    return (
      <View className="flex-row" style={{ height: DEBUG_DIFF_ROW_HEIGHT, width: props.width }}>
        <DebugDiffStickyCell item={props.row} />
        <View
          onTouchStart={() => props.onActivateFile(props.row.fileId)}
          style={{ overflow: "hidden", width: viewportWidth }}
        >
          <Animated.View style={{ transform: [{ translateX: horizontalOffset }] }}>
            <DebugDiffCodeCell item={props.row} tokens={null} />
          </Animated.View>
        </View>
      </View>
    );
  }

  return (
    <DebugDiffLineRowView
      horizontalOffset={props.horizontalOffsetStore.getValue(props.row.fileId)}
      onActivateFile={props.onActivateFile}
      row={props.row}
      tokenStore={props.tokenStore}
      viewportWidth={viewportWidth}
    />
  );
});

function EngineToggle(props: {
  readonly engine: DebugHighlightEngine;
  readonly onChangeEngine: (engine: DebugHighlightEngine) => void;
}) {
  return (
    <View className="flex-row rounded-full bg-subtle p-1">
      {(["native", "javascript"] as const).map((engine) => {
        const selected = props.engine === engine;
        return (
          <Pressable
            key={engine}
            className={cn("rounded-full px-3 py-1.5", selected && "bg-card")}
            onPress={() => props.onChangeEngine(engine)}
          >
            <Text
              className={cn(
                "text-[12px] font-t3-bold",
                selected ? "text-foreground" : "text-foreground-muted",
              )}
            >
              {engine === "javascript" ? "JS" : "Native"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function FixtureToggle(props: {
  readonly fixtureId: DebugReviewDiffFixtureId;
  readonly onChangeFixture: (fixtureId: DebugReviewDiffFixtureId) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="flex-row gap-2">
        {debugReviewDiffFixtures.map((fixture) => {
          const selected = props.fixtureId === fixture.id;
          return (
            <Pressable
              key={fixture.id}
              className={cn(
                "rounded-full border border-border px-3 py-1.5",
                selected ? "bg-foreground" : "bg-card",
              )}
              onPress={() => props.onChangeFixture(fixture.id)}
            >
              <Text
                className={cn(
                  "text-[12px] font-t3-bold",
                  selected ? "text-sheet" : "text-foreground",
                )}
              >
                {fixture.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

export default function SyntaxHighlightDebugRoute() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const headerIcon = String(useThemeColor("--color-icon"));
  const themeName = DEBUG_THEME_NAME_BY_SCHEME[colorScheme === "dark" ? "dark" : "light"];
  const [engine, setEngine] = useState<DebugHighlightEngine>("native");
  const [fixtureId, setFixtureId] = useState<DebugReviewDiffFixtureId>("small");
  const [status, setStatus] = useState("Idle");
  const renderStartRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const tokenStore = useMemo(() => new DebugTokenStore(), []);
  const horizontalOffsetStore = useMemo(() => new DebugHorizontalOffsetStore(), []);
  const activeHorizontalFileIdRef = useRef<string | null>(null);
  const horizontalDragStartRef = useRef(0);

  const fixture = useMemo(
    () =>
      debugReviewDiffFixtures.find((candidate) => candidate.id === fixtureId) ??
      debugReviewDiffFixtures[0],
    [fixtureId],
  );
  const parsedDiff = useMemo(() => parseDebugDiffFixture(fixture), [fixture]);
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    renderStartRef.current = performance.now();
    tokenStore.reset();
    horizontalOffsetStore.reset();
    setStatus("Initializing highlighter");

    void (async () => {
      try {
        const highlighterStartedAt = performance.now();
        const highlighter = await getDebugHighlighter(engine);
        if (generation !== generationRef.current) {
          return;
        }

        console.log("[debug-diff-scratch] initialize", {
          durationMs: Math.round(performance.now() - highlighterStartedAt),
          engine: highlighter.engine,
        });

        let firstChunkMs: number | null = null;
        const totalStartedAt = performance.now();
        setStatus(`Streaming ${parsedDiff.highlightChunks.length.toLocaleString()} chunks`);

        for (let chunkIndex = 0; chunkIndex < parsedDiff.highlightChunks.length; chunkIndex += 1) {
          if (generation !== generationRef.current) {
            return;
          }

          const chunk = parsedDiff.highlightChunks[chunkIndex];
          if (!chunk) {
            continue;
          }

          const chunkCode = chunk.rows.map((line) => line.content).join("\n");
          const chunkStartedAt = performance.now();
          const chunkTokens = highlighter.tokenize(chunkCode, {
            lang: chunk.language,
            theme: themeName,
          });
          const chunkMs = performance.now() - chunkStartedAt;

          if (firstChunkMs === null) {
            firstChunkMs = performance.now() - totalStartedAt;
            console.log("[debug-diff-scratch] first chunk", {
              durationMs: Math.round(firstChunkMs),
              engine,
              fixture: fixture.id,
              language: chunk.language,
              lineCount: chunkTokens.length,
            });
          }

          tokenStore.setChunk(chunk, chunkTokens);

          console.log("[debug-diff-scratch] chunk", {
            chunkIndex,
            chunkMs: Math.round(chunkMs),
            engine,
            fixture: fixture.id,
            language: chunk.language,
            lineCount: chunkTokens.length,
          });

          await waitForNextFrame();
        }

        console.log("[debug-diff-scratch] complete", {
          durationMs: Math.round(performance.now() - totalStartedAt),
          engine,
          fixture: fixture.id,
          rows: parsedDiff.rows.length,
        });
        setStatus(`Complete with ${engine}`);
      } catch (error) {
        console.error("[debug-diff-scratch] failed", {
          engine,
          message: error instanceof Error ? error.message : String(error),
        });
        setStatus(error instanceof Error ? error.message : "Highlight failed");
      }
    })();
  }, [
    engine,
    fixture.id,
    parsedDiff.highlightChunks,
    parsedDiff.rows.length,
    themeName,
    horizontalOffsetStore,
    tokenStore,
  ]);

  useEffect(() => {
    if (renderStartRef.current === null) {
      return;
    }

    const startedAt = renderStartRef.current;
    renderStartRef.current = null;
    const commitMs = performance.now() - startedAt;
    requestAnimationFrame(() => {
      console.log("[debug-diff-scratch] render", {
        commitMs: Math.round(commitMs),
        paintMs: Math.round(performance.now() - startedAt),
      });
    });
  });

  const onActivateHorizontalFile = useCallback((fileId: string) => {
    activeHorizontalFileIdRef.current = fileId;
  }, []);

  const maxHorizontalOffset = Math.max(
    0,
    DEBUG_CONTENT_WIDTH - Math.max(0, width - DEBUG_STICKY_WIDTH),
  );
  const horizontalPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) => {
          const horizontalDistance = Math.abs(gestureState.dx);
          const verticalDistance = Math.abs(gestureState.dy);
          return horizontalDistance > 8 && horizontalDistance > verticalDistance * 1.25;
        },
        onPanResponderGrant: () => {
          const fileId = activeHorizontalFileIdRef.current;
          horizontalDragStartRef.current = fileId ? horizontalOffsetStore.getOffset(fileId) : 0;
        },
        onPanResponderMove: (_event, gestureState) => {
          const fileId = activeHorizontalFileIdRef.current;
          if (!fileId) {
            return;
          }
          const nextOffset = Math.min(
            Math.max(horizontalDragStartRef.current - gestureState.dx, 0),
            maxHorizontalOffset,
          );
          horizontalOffsetStore.setOffset(fileId, nextOffset);
        },
        onPanResponderTerminationRequest: () => true,
      }),
    [horizontalOffsetStore, maxHorizontalOffset],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<DebugDiffRow>) => (
      <DebugDiffFlatRowView
        horizontalOffsetStore={horizontalOffsetStore}
        onActivateFile={onActivateHorizontalFile}
        row={item}
        tokenStore={tokenStore}
        width={width}
      />
    ),
    [horizontalOffsetStore, onActivateHorizontalFile, tokenStore, width],
  );

  return (
    <View className="flex-1 bg-sheet">
      <Stack.Screen
        options={{
          headerShown: true,
          headerTitle: "Diff Scratch",
          headerTintColor: headerIcon,
          headerTransparent: true,
          headerShadowVisible: false,
          gestureEnabled: false,
        }}
      />

      <View
        className="gap-3 border-b border-border bg-sheet px-3 pb-3"
        style={{ paddingTop: insets.top + 56 }}
      >
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-[13px] font-t3-bold text-foreground">Diff streaming scratch</Text>
            <Text className="text-[11px] text-foreground-muted" numberOfLines={1}>
              {fixture.label} · {parsedDiff.files.length} files · {parsedDiff.rows.length} rows ·{" "}
              {status}
            </Text>
          </View>
          <EngineToggle engine={engine} onChangeEngine={setEngine} />
        </View>
        <FixtureToggle fixtureId={fixtureId} onChangeFixture={setFixtureId} />
      </View>

      <View className="flex-1" {...horizontalPanResponder.panHandlers}>
        <FlatList
          style={{ flex: 1, width }}
          data={parsedDiff.rows}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          getItemLayout={(_, index) => ({
            length: DEBUG_DIFF_ROW_HEIGHT,
            offset: DEBUG_DIFF_ROW_HEIGHT * index,
            index,
          })}
          initialNumToRender={28}
          maxToRenderPerBatch={32}
          updateCellsBatchingPeriod={24}
          windowSize={7}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        />
      </View>
    </View>
  );
}
