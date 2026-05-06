import Stack from "expo-router/stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  StyleSheet,
  Text as NativeText,
  type NativeSyntheticEvent,
  useColorScheme,
  View,
} from "react-native";
import {
  debugReviewDiffFixtures,
  type DebugReviewDiffFixtureId,
} from "../../features/debug/fixtures/reviewDiffFixtures";
import {
  getResolvedNativeReviewDiffModuleName,
  type NativeReviewDiffStyle,
  type NativeReviewDiffTheme,
  resolveNativeReviewDiffView,
} from "../../features/debug/native-review-diff/nativeReviewDiffModule";
import {
  highlightNativeReviewDiffVisibleRows,
  streamNativeReviewDiffTokens,
  type NativeReviewDiffHighlightEngine,
} from "../../features/debug/native-review-diff/nativeReviewDiffHighlighter";
import {
  getNativeReviewDiffFixture,
  parseNativeReviewDiffFixture,
} from "../../features/debug/native-review-diff/nativeReviewDiffParser";
import {
  getPierreTerminalTheme,
  type TerminalAppearanceScheme,
} from "../../features/terminal/terminalTheme";

const NATIVE_DEBUG_ROW_HEIGHT = 20;
const NATIVE_DEBUG_CONTENT_WIDTH = 2800;
const NATIVE_DEBUG_STYLE = {
  rowHeight: NATIVE_DEBUG_ROW_HEIGHT,
  contentWidth: NATIVE_DEBUG_CONTENT_WIDTH,
  changeBarWidth: 4,
  gutterWidth: 46,
  codePadding: 7,
  textVerticalInset: 2,
  fileHeaderHeight: 56,
  fileHeaderHorizontalMargin: 8,
  fileHeaderVerticalMargin: 6,
  fileHeaderCornerRadius: 10,
  fileHeaderHorizontalPadding: 10,
  fileHeaderPathRightPadding: 118,
  fileHeaderCountColumnWidth: 38,
  fileHeaderCountGap: 5,
  codeFontSize: 11,
  codeFontWeight: "regular",
  lineNumberFontSize: 10,
  lineNumberFontWeight: "regular",
  hunkFontSize: 11,
  hunkFontWeight: "medium",
  fileHeaderFontSize: 11,
  fileHeaderFontWeight: "semibold",
  fileHeaderMetaFontSize: 10,
  fileHeaderMetaFontWeight: "semibold",
  fileHeaderSubtextFontSize: 11,
  fileHeaderSubtextFontWeight: "medium",
  fileHeaderStatusFontSize: 9,
  fileHeaderStatusFontWeight: "bold",
  emptyStateFontSize: 12,
  emptyStateFontWeight: "medium",
} satisfies NativeReviewDiffStyle;

function createNativeReviewDiffTheme(scheme: TerminalAppearanceScheme): NativeReviewDiffTheme {
  const terminalTheme = getPierreTerminalTheme(scheme);
  const [, terminalRed, , , terminalBlue] = terminalTheme.palette;

  if (scheme === "dark") {
    return {
      background: terminalTheme.background,
      text: terminalTheme.foreground,
      mutedText: terminalTheme.mutedForeground,
      headerBackground: terminalTheme.background,
      border: terminalTheme.border,
      hunkBackground: "#071f28",
      hunkText: terminalBlue ?? "#009fff",
      addBackground: "#0d2f28",
      deleteBackground: "#391415",
      addBar: "#00cab1",
      deleteBar: terminalRed ?? "#ff2e3f",
      addText: "#5ECC71",
      deleteText: "#FF6762",
    };
  }

  return {
    background: "#ffffff",
    text: "#070707",
    mutedText: terminalTheme.mutedForeground,
    headerBackground: "#ffffff",
    border: terminalTheme.border,
    hunkBackground: "#e0f2ff",
    hunkText: terminalBlue ?? "#009fff",
    addBackground: "#e5f8f5",
    deleteBackground: "#ffe6e7",
    addBar: "#00cab1",
    deleteBar: terminalRed ?? "#ff2e3f",
    addText: "#199F43",
    deleteText: "#D52C36",
  };
}

export default function NativeReviewDiffDebugRoute() {
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const [fixtureId, setFixtureId] = useState<DebugReviewDiffFixtureId>("large");
  const [highlightEngine, setHighlightEngine] = useState<NativeReviewDiffHighlightEngine>("native");
  const [collapsedFileIds, setCollapsedFileIds] = useState<ReadonlyArray<string>>([]);
  const [viewedFileIds, setViewedFileIds] = useState<ReadonlyArray<string>>([]);
  const fixture = getNativeReviewDiffFixture(fixtureId);
  const parsed = useMemo(() => parseNativeReviewDiffFixture(fixture), [fixture]);
  const effectiveHighlightEngine: NativeReviewDiffHighlightEngine =
    fixtureId === "xl" && highlightEngine === "native" ? "javascript" : highlightEngine;
  const useVisibleOnlyHighlighting = fixtureId === "xl";
  const debugTheme = useMemo(() => createNativeReviewDiffTheme(colorScheme), [colorScheme]);
  const rowsJson = useMemo(() => JSON.stringify(parsed.rows), [parsed.rows]);
  const collapsedFileIdsJson = useMemo(() => JSON.stringify(collapsedFileIds), [collapsedFileIds]);
  const viewedFileIdsJson = useMemo(() => JSON.stringify(viewedFileIds), [viewedFileIds]);
  const themeJson = useMemo(() => JSON.stringify(debugTheme), [debugTheme]);
  const styleJson = useMemo(() => JSON.stringify(NATIVE_DEBUG_STYLE), []);
  const tokensResetKey = `${fixtureId}:${colorScheme}:${effectiveHighlightEngine}`;
  const [tokensPatchJson, setTokensPatchJson] = useState(
    JSON.stringify({ resetKey: "", tokensByRowId: {} }),
  );
  const highlightedRowIdsRef = useRef<Set<string>>(new Set());
  const visibleRangeRef = useRef({ firstRowIndex: 0, lastRowIndex: 80 });
  const visibleChunkIndexRef = useRef(0);
  const useVisibleOnlyHighlightingRef = useRef(useVisibleOnlyHighlighting);
  const [visibleHighlightRequest, setVisibleHighlightRequest] = useState(0);
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const handleSelectFixture = useCallback((nextFixtureId: DebugReviewDiffFixtureId) => {
    setFixtureId(nextFixtureId);
  }, []);
  useEffect(() => {
    useVisibleOnlyHighlightingRef.current = useVisibleOnlyHighlighting;
  }, [useVisibleOnlyHighlighting]);
  useEffect(() => {
    setCollapsedFileIds([]);
    setViewedFileIds([]);
  }, [fixtureId]);
  useEffect(() => {
    const abortController = new AbortController();
    highlightedRowIdsRef.current = new Set();
    visibleChunkIndexRef.current = 0;
    setTokensPatchJson(JSON.stringify({ resetKey: tokensResetKey, tokensByRowId: {} }));
    if (useVisibleOnlyHighlighting) {
      setVisibleHighlightRequest((request) => request + 1);
      console.log("[debug-native-diff] visible-only highlight start", {
        fixture: fixtureId,
        files: parsed.files.length,
        rows: parsed.rows.length,
        scheme: colorScheme,
        effectiveEngine: effectiveHighlightEngine,
        requestedEngine: highlightEngine,
      });
      return () => abortController.abort();
    }

    void (async () => {
      const startedAt = performance.now();
      console.log("[debug-native-diff] highlight start", {
        fixture: fixtureId,
        files: parsed.files.length,
        rows: parsed.rows.length,
        scheme: colorScheme,
        effectiveEngine: effectiveHighlightEngine,
        requestedEngine: highlightEngine,
      });

      try {
        const engine = await streamNativeReviewDiffTokens({
          files: parsed.files,
          rows: parsed.rows,
          scheme: colorScheme,
          engine: effectiveHighlightEngine,
          signal: abortController.signal,
          onChunk: (chunk) => {
            if (abortController.signal.aborted) {
              return;
            }

            setTokensPatchJson(JSON.stringify({ resetKey: tokensResetKey, ...chunk }));
            if (chunk.chunkIndex < 5 || chunk.chunkIndex % 10 === 0) {
              console.log("[debug-native-diff] highlight chunk", {
                chunkIndex: chunk.chunkIndex,
                durationMs: chunk.durationMs,
                filePath: chunk.filePath,
                lineCount: chunk.lineCount,
              });
            }
          },
        });

        if (!abortController.signal.aborted) {
          console.log("[debug-native-diff] highlight complete", {
            durationMs: Math.round(performance.now() - startedAt),
            engine,
            fixture: fixtureId,
            effectiveEngine: effectiveHighlightEngine,
            requestedEngine: highlightEngine,
          });
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.warn("[debug-native-diff] highlight failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => abortController.abort();
  }, [
    colorScheme,
    effectiveHighlightEngine,
    fixtureId,
    highlightEngine,
    parsed.files,
    parsed.rows,
    tokensResetKey,
    useVisibleOnlyHighlighting,
  ]);
  useEffect(() => {
    if (!useVisibleOnlyHighlighting) {
      return;
    }

    const abortController = new AbortController();
    const requestRange = visibleRangeRef.current;

    void (async () => {
      try {
        const result = await highlightNativeReviewDiffVisibleRows({
          files: parsed.files,
          rows: parsed.rows,
          scheme: colorScheme,
          engine: effectiveHighlightEngine,
          firstRowIndex: requestRange.firstRowIndex,
          lastRowIndex: requestRange.lastRowIndex,
          alreadyHighlightedRowIds: highlightedRowIdsRef.current,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted || result.rowCount === 0) {
          return;
        }

        for (const rowId of Object.keys(result.tokensByRowId)) {
          highlightedRowIdsRef.current.add(rowId);
        }

        const chunkIndex = visibleChunkIndexRef.current;
        visibleChunkIndexRef.current += 1;
        setTokensPatchJson(
          JSON.stringify({
            resetKey: tokensResetKey,
            chunkIndex,
            fileId: "visible",
            filePath: "visible rows",
            language: "diff",
            lineCount: result.rowCount,
            durationMs: result.durationMs,
            tokensByRowId: result.tokensByRowId,
          }),
        );
        if (chunkIndex < 2 || chunkIndex % 10 === 0) {
          console.log("[debug-native-diff] visible highlight chunk", {
            chunkIndex,
            durationMs: result.durationMs,
            highlightedRows: result.rowCount,
            firstRowIndex: requestRange.firstRowIndex,
            lastRowIndex: requestRange.lastRowIndex,
          });
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.warn("[debug-native-diff] visible highlight failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => abortController.abort();
  }, [
    colorScheme,
    effectiveHighlightEngine,
    parsed.files,
    parsed.rows,
    tokensResetKey,
    useVisibleOnlyHighlighting,
    visibleHighlightRequest,
  ]);
  useEffect(() => {
    console.log("[debug-native-diff] native view availability", {
      available: NativeReviewDiffView != null,
      moduleName: getResolvedNativeReviewDiffModuleName(),
      rowsJsonLength: rowsJson.length,
    });
  }, [NativeReviewDiffView, rowsJson.length]);
  const handleNativeContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    console.log("[debug-native-diff] native container layout", {
      height: Math.round(height),
      width: Math.round(width),
    });
  }, []);
  const handleNativeLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    console.log("[debug-native-diff] native view layout", {
      height: Math.round(height),
      width: Math.round(width),
    });
  }, []);
  const handleNativeDebug = useCallback((event: NativeSyntheticEvent<Record<string, unknown>>) => {
    const payload = event.nativeEvent;
    const message = payload.message;

    if (
      useVisibleOnlyHighlightingRef.current &&
      (message === "draw-metrics" || message === "visible-range") &&
      typeof payload.firstRowIndex === "number" &&
      typeof payload.lastRowIndex === "number"
    ) {
      const previousRange = visibleRangeRef.current;
      const nextRange = {
        firstRowIndex: payload.firstRowIndex,
        lastRowIndex: payload.lastRowIndex,
      };
      const movedRows =
        Math.abs(nextRange.firstRowIndex - previousRange.firstRowIndex) +
        Math.abs(nextRange.lastRowIndex - previousRange.lastRowIndex);

      visibleRangeRef.current = nextRange;
      if (movedRows >= 20) {
        setVisibleHighlightRequest((request) => request + 1);
      }
    }
  }, []);
  const handleToggleFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (!fileId) {
        return;
      }

      setCollapsedFileIds((current) =>
        current.includes(fileId) ? current.filter((id) => id !== fileId) : [...current, fileId],
      );
    },
    [],
  );
  const handleToggleViewedFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (!fileId) {
        return;
      }

      setViewedFileIds((current) => {
        if (current.includes(fileId)) {
          return current.filter((id) => id !== fileId);
        }

        setCollapsedFileIds((collapsed) =>
          collapsed.includes(fileId) ? collapsed : [...collapsed, fileId],
        );
        return [...current, fileId];
      });
    },
    [],
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: debugTheme.background },
          headerTintColor: debugTheme.text,
          headerTitleAlign: "center",
          title: "",
          headerTitle: () => (
            <View style={{ alignItems: "center", maxWidth: 240 }}>
              <NativeText
                numberOfLines={1}
                style={{
                  color: debugTheme.text,
                  fontFamily: "DMSans_700Bold",
                  fontSize: 13,
                  lineHeight: 16,
                }}
              >
                Native review diff
              </NativeText>
              <NativeText
                numberOfLines={1}
                style={{
                  color: debugTheme.mutedText,
                  fontFamily: "DMSans_700Bold",
                  fontSize: 11,
                  lineHeight: 14,
                }}
              >
                {parsed.files.length} files · {parsed.rows.length} rows · +{parsed.additions} -
                {parsed.deletions} · {effectiveHighlightEngine === "native" ? "native" : "JS"}
                {fixtureId === "xl" && highlightEngine === "native" ? " fallback" : ""}
              </NativeText>
            </View>
          ),
        }}
      />

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon="line.3.horizontal.decrease.circle"
          title="Diff debug options"
          separateBackground
        >
          <Stack.Toolbar.Menu icon="sparkles" inline title="Highlighter engine">
            <Stack.Toolbar.Label>Highlighter engine</Stack.Toolbar.Label>
            {(["native", "javascript"] as const).map((engine) => {
              const isSelected = engine === highlightEngine;
              return (
                <Stack.Toolbar.MenuAction
                  key={engine}
                  icon="circle"
                  isOn={isSelected}
                  onPress={() => setHighlightEngine(engine)}
                  subtitle={
                    engine === "native" && fixtureId === "xl"
                      ? "XL currently falls back after native engine crash"
                      : engine === "native"
                        ? "react-native-shiki-engine"
                        : "JavaScript regex engine"
                  }
                >
                  <Stack.Toolbar.Label>
                    {engine === "native" ? "Native" : "JavaScript"}
                  </Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
              );
            })}
          </Stack.Toolbar.Menu>

          <Stack.Toolbar.Menu icon="doc.text" inline title="Fixture">
            <Stack.Toolbar.Label>Fixture</Stack.Toolbar.Label>
            {debugReviewDiffFixtures.map((candidate) => {
              const isSelected = candidate.id === fixtureId;
              return (
                <Stack.Toolbar.MenuAction
                  key={candidate.id}
                  icon="doc.text"
                  isOn={isSelected}
                  onPress={() => handleSelectFixture(candidate.id)}
                  subtitle={`${candidate.lineCount} patch lines`}
                >
                  <Stack.Toolbar.Label>{candidate.label}</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
              );
            })}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <View
        className="relative flex-1"
        style={{ backgroundColor: debugTheme.background }}
        collapsable={false}
        onLayout={handleNativeContainerLayout}
      >
        {NativeReviewDiffView ? (
          <NativeReviewDiffView
            key={fixtureId}
            collapsable={false}
            testID="native-review-diff-view"
            style={StyleSheet.absoluteFillObject}
            appearanceScheme={colorScheme}
            contentWidth={NATIVE_DEBUG_CONTENT_WIDTH}
            collapsedFileIdsJson={collapsedFileIdsJson}
            rowHeight={NATIVE_DEBUG_ROW_HEIGHT}
            rowsJson={rowsJson}
            styleJson={styleJson}
            themeJson={themeJson}
            tokensResetKey={tokensResetKey}
            tokensPatchJson={tokensPatchJson}
            viewedFileIdsJson={viewedFileIdsJson}
            onDebug={handleNativeDebug}
            onLayout={handleNativeLayout}
            onToggleFile={handleToggleFile}
            onToggleViewedFile={handleToggleViewedFile}
          />
        ) : (
          <View className="flex-1 items-center justify-center px-8">
            <NativeText
              style={{
                color: debugTheme.text,
                fontFamily: "DMSans_700Bold",
                fontSize: 14,
                textAlign: "center",
              }}
            >
              Native review diff view is not available in this build.
            </NativeText>
            <NativeText
              style={{
                color: debugTheme.mutedText,
                fontFamily: "DMSans_400Regular",
                fontSize: 12,
                marginTop: 8,
                textAlign: "center",
              }}
            >
              Expected native view manager: T3ReviewDiffSurface. Rebuild the current iOS development
              client with `bun ios` after native module changes.
            </NativeText>
          </View>
        )}
      </View>
    </>
  );
}
