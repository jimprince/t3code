import { EnvironmentId, ThreadId, type OrchestrationCheckpointSummary } from "@t3tools/contracts";
import { useLocalSearchParams } from "expo-router";
import Stack from "expo-router/stack";
import { memo, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  type NativeSyntheticEvent,
  Text as NativeText,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { getEnvironmentClient } from "../../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  getCachedReviewParsedDiff,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  updateReviewExpandedFileIds,
  updateReviewViewedFileIds,
  useReviewCacheForThread,
} from "./reviewState";
import {
  getReadyReviewCheckpoints,
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReviewSectionIdForCheckpoint,
  type ReviewParsedDiff,
  type ReviewRenderableFile,
} from "./reviewModel";
import { countReviewCommentContexts } from "./reviewCommentSelection";
import { markReviewEvent, measureReviewWork } from "./reviewPerf";
import {
  highlightNativeReviewDiffVisibleRows,
  type NativeReviewDiffHighlightEngine,
} from "../debug/native-review-diff/nativeReviewDiffHighlighter";
import { resolveNativeReviewDiffView } from "../debug/native-review-diff/nativeReviewDiffModule";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
  NATIVE_REVIEW_DIFF_ROW_HEIGHT,
  NATIVE_REVIEW_DIFF_STYLE,
} from "./nativeReviewDiffAdapter";

const IOS_NAV_BAR_HEIGHT = 44;
const REVIEW_HEADER_SPACING = 0;

function isReviewDiffDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewDiffDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!isReviewDiffDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-sheet] ${message}`, details);
    return;
  }

  console.log(`[review-sheet] ${message}`);
}

function formatHeaderDiffSummary(parsedDiff: ReviewParsedDiff): {
  readonly additions: string | null;
  readonly deletions: string | null;
} {
  if (parsedDiff.kind !== "files") {
    return { additions: null, deletions: null };
  }

  return {
    additions: `+${parsedDiff.additions}`,
    deletions: `-${parsedDiff.deletions}`,
  };
}

function hashReviewDiffKey(diff: string | null | undefined): string {
  if (!diff) {
    return "empty";
  }

  let hash = 5381;
  for (let index = 0; index < diff.length; index += 1) {
    hash = (hash * 33) ^ diff.charCodeAt(index);
  }

  return `${diff.length}:${(hash >>> 0).toString(36)}`;
}

function getDefaultExpandedFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
): ReadonlyArray<string> {
  return files.map((file) => file.id);
}

function getValidReviewExpandedFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  cachedExpandedFileIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (cachedExpandedFileIds === undefined) {
    return getDefaultExpandedFileIds(files);
  }

  const fileIdSet = new Set(files.map((file) => file.id));
  return cachedExpandedFileIds.filter((id) => fileIdSet.has(id));
}

const ReviewNotice = memo(function ReviewNotice(props: { readonly notice: string }) {
  return (
    <View className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40">
      <Text className="text-[12px] font-t3-bold uppercase text-amber-700 dark:text-amber-300">
        Partial diff
      </Text>
      <Text className="text-[12px] leading-[18px] text-amber-800 dark:text-amber-200">
        {props.notice}
      </Text>
    </View>
  );
});

export function ReviewSheet() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const headerForeground = String(useThemeColor("--color-foreground"));
  const headerMuted = String(useThemeColor("--color-foreground-muted"));
  const headerIcon = String(useThemeColor("--color-icon"));
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
  }>();
  const { draftMessage } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const selectedThread = useSelectedThreadDetail();
  const [loadingTurnIds, setLoadingTurnIds] = useState<Record<string, boolean>>({});
  const [loadingGitDiffs, setLoadingGitDiffs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localExpandedFileIdsBySection, setLocalExpandedFileIdsBySection] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  const [localViewedFileIdsBySection, setLocalViewedFileIdsBySection] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  const [nativeTokensPatchJson, setNativeTokensPatchJson] = useState(
    JSON.stringify({ resetKey: "", tokensByRowId: {} }),
  );
  const selectedTheme = colorScheme === "dark" ? "dark" : "light";
  const nativeHighlightedRowIdsRef = useRef<Set<string>>(new Set());
  const nativeVisibleRangeRef = useRef({ firstRowIndex: 0, lastRowIndex: 80 });
  const nativeVisibleChunkIndexRef = useRef(0);
  const [nativeVisibleHighlightRequest, setNativeVisibleHighlightRequest] = useState(0);
  const { selectedThreadCwd } = useSelectedThreadWorktree();

  const cwd = selectedThreadCwd;
  const readyCheckpoints = useMemo(
    () => getReadyReviewCheckpoints(selectedThread?.checkpoints ?? []),
    [selectedThread?.checkpoints],
  );

  const checkpointBySectionId = useMemo(() => {
    return Object.fromEntries(
      readyCheckpoints.map((checkpoint) => [
        getReviewSectionIdForCheckpoint(checkpoint),
        checkpoint,
      ]),
    ) as Record<string, OrchestrationCheckpointSummary>;
  }, [readyCheckpoints]);

  const reviewSections = useMemo(
    () =>
      buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections: reviewCache.gitSections,
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
      }),
    [loadingTurnIds, readyCheckpoints, reviewCache.gitSections, reviewCache.turnDiffById],
  );

  const selectedSection =
    reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
    reviewSections[0] ??
    null;
  const topContentInset = insets.top + IOS_NAV_BAR_HEIGHT;
  const parsedDiff = useMemo(
    () =>
      measureReviewWork("parse-diff", () =>
        getCachedReviewParsedDiff({
          threadKey: reviewCache.threadKey,
          sectionId: selectedSection?.id ?? null,
          diff: selectedSection?.diff,
        }),
      ),
    [reviewCache.threadKey, selectedSection?.diff, selectedSection?.id],
  );
  const headerDiffSummary = useMemo(() => formatHeaderDiffSummary(parsedDiff), [parsedDiff]);
  const NativeReviewDiffView = resolveNativeReviewDiffView()!;
  const nativeReviewDiffData = useMemo(
    () => measureReviewWork("build-native-diff-data", () => buildNativeReviewDiffData(parsedDiff)),
    [parsedDiff],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(selectedTheme),
    [selectedTheme],
  );
  const nativeRowsJson = useMemo(
    () => JSON.stringify(nativeReviewDiffData.rows),
    [nativeReviewDiffData.rows],
  );
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(() => JSON.stringify(NATIVE_REVIEW_DIFF_STYLE), []);
  const nativeTokensResetKey = useMemo(
    () =>
      [
        reviewCache.threadKey,
        selectedSection?.id ?? "none",
        selectedTheme,
        hashReviewDiffKey(selectedSection?.diff),
        nativeReviewDiffData.files.length,
        nativeReviewDiffData.rows.length,
      ].join(":"),
    [
      nativeReviewDiffData.files.length,
      nativeReviewDiffData.rows.length,
      reviewCache.threadKey,
      selectedSection?.diff,
      selectedSection?.id,
      selectedTheme,
    ],
  );
  const pendingReviewCommentCount = useMemo(
    () => countReviewCommentContexts(draftMessage),
    [draftMessage],
  );
  useEffect(() => {
    if (!selectedSection?.id || parsedDiff.kind !== "files") {
      return;
    }

    setLocalExpandedFileIdsBySection((current) => {
      if (current[selectedSection.id] !== undefined) {
        return current;
      }

      return {
        ...current,
        [selectedSection.id]: getValidReviewExpandedFileIds(
          parsedDiff.files,
          reviewCache.expandedFileIdsBySection[selectedSection.id],
        ),
      };
    });

    setLocalViewedFileIdsBySection((current) => {
      if (current[selectedSection.id] !== undefined) {
        return current;
      }

      return {
        ...current,
        [selectedSection.id]: reviewCache.viewedFileIdsBySection[selectedSection.id] ?? [],
      };
    });
  }, [
    parsedDiff,
    reviewCache.expandedFileIdsBySection,
    reviewCache.viewedFileIdsBySection,
    selectedSection?.id,
  ]);

  const expandedFileIds = useMemo(
    () =>
      selectedSection?.id && parsedDiff.kind === "files"
        ? getValidReviewExpandedFileIds(
            parsedDiff.files,
            localExpandedFileIdsBySection[selectedSection.id],
          )
        : [],
    [localExpandedFileIdsBySection, parsedDiff, selectedSection?.id],
  );
  const viewedFileIds = useMemo(
    () => (selectedSection?.id ? (localViewedFileIdsBySection[selectedSection.id] ?? []) : []),
    [localViewedFileIdsBySection, selectedSection?.id],
  );
  const nativeCollapsedFileIds = useMemo(() => {
    if (parsedDiff.kind !== "files") {
      return [];
    }

    const expandedFileIdSet = new Set(expandedFileIds);
    return parsedDiff.files
      .filter((file) => !expandedFileIdSet.has(file.id))
      .map((file) => file.id);
  }, [expandedFileIds, parsedDiff]);
  const nativeCollapsedFileIdsJson = useMemo(
    () => JSON.stringify(nativeCollapsedFileIds),
    [nativeCollapsedFileIds],
  );
  const nativeViewedFileIdsJson = useMemo(() => JSON.stringify(viewedFileIds), [viewedFileIds]);
  const loadGitDiffs = useCallback(async () => {
    if (!cwd) {
      return;
    }

    const client = getEnvironmentClient(environmentId);
    if (!client) {
      setError("Remote connection is not ready.");
      return;
    }

    setLoadingGitDiffs(true);
    setError(null);
    try {
      const result = await client.git.getReviewDiffs({ cwd });
      if (reviewCache.threadKey) {
        setReviewGitSections(reviewCache.threadKey, result.sections);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load review diffs.");
    } finally {
      setLoadingGitDiffs(false);
    }
  }, [cwd, environmentId, reviewCache.threadKey]);

  const loadTurnDiff = useCallback(
    async (checkpoint: OrchestrationCheckpointSummary, force = false) => {
      if (!threadId) {
        return;
      }

      const sectionId = getReviewSectionIdForCheckpoint(checkpoint);
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }

      if (!force && reviewCache.turnDiffById[sectionId] !== undefined) {
        return;
      }

      const client = getEnvironmentClient(environmentId);
      if (!client) {
        setError("Remote connection is not ready.");
        return;
      }

      setLoadingTurnIds((current) => ({ ...current, [sectionId]: true }));
      setError(null);
      try {
        const result = await client.orchestration.getTurnDiff({
          threadId: ThreadId.make(threadId),
          fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
          toTurnCount: checkpoint.checkpointTurnCount,
        });
        if (reviewCache.threadKey) {
          setReviewTurnDiff(reviewCache.threadKey, sectionId, result.diff);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to load turn diff.");
      } finally {
        setLoadingTurnIds((current) => {
          const next = { ...current };
          delete next[sectionId];
          return next;
        });
      }
    },
    [environmentId, reviewCache.threadKey, reviewCache.turnDiffById, threadId],
  );

  useEffect(() => {
    void loadGitDiffs();
  }, [loadGitDiffs]);

  useEffect(() => {
    if (reviewSections.length === 0) {
      return;
    }

    const fallbackId = getDefaultReviewSectionId(reviewSections);
    if (
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId ||
        !reviewSections.some((section) => section.id === reviewCache.selectedSectionId))
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackId);
    }
  }, [reviewCache.selectedSectionId, reviewCache.threadKey, reviewSections]);

  useEffect(() => {
    const latest = readyCheckpoints[0];
    if (!latest) {
      return;
    }

    const latestId = getReviewSectionIdForCheckpoint(latest);
    if (reviewCache.turnDiffById[latestId] !== undefined || loadingTurnIds[latestId]) {
      return;
    }

    void loadTurnDiff(latest);
  }, [loadTurnDiff, loadingTurnIds, readyCheckpoints, reviewCache.turnDiffById]);

  useEffect(() => {
    if (!selectedSection || selectedSection.kind !== "turn" || selectedSection.diff !== null) {
      return;
    }

    const checkpoint = checkpointBySectionId[selectedSection.id];
    if (checkpoint && !loadingTurnIds[selectedSection.id]) {
      void loadTurnDiff(checkpoint);
    }
  }, [checkpointBySectionId, loadTurnDiff, loadingTurnIds, selectedSection]);

  useEffect(() => {
    if (!reviewCache.threadKey || !selectedSection?.id || parsedDiff.kind !== "files") {
      return;
    }

    updateReviewExpandedFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
      const validIds = getValidReviewExpandedFileIds(parsedDiff.files, existing);
      if (
        existing !== undefined &&
        validIds.length === existing.length &&
        validIds.every((id, index) => id === existing[index])
      ) {
        return existing;
      }
      return validIds;
    });
  }, [parsedDiff, reviewCache.threadKey, selectedSection?.id]);

  useEffect(() => {
    nativeHighlightedRowIdsRef.current = new Set();
    nativeVisibleChunkIndexRef.current = 0;
    nativeVisibleRangeRef.current = { firstRowIndex: 0, lastRowIndex: 80 };
    setNativeTokensPatchJson(JSON.stringify({ resetKey: nativeTokensResetKey, tokensByRowId: {} }));
    if (nativeReviewDiffData.rows.length > 0) {
      setNativeVisibleHighlightRequest((request) => request + 1);
    }
  }, [nativeReviewDiffData.rows.length, nativeTokensResetKey]);

  useEffect(() => {
    if (parsedDiff.kind !== "files" || nativeReviewDiffData.rows.length === 0) {
      return;
    }

    const abortController = new AbortController();
    const requestRange = nativeVisibleRangeRef.current;
    const engine: NativeReviewDiffHighlightEngine = "native";

    void (async () => {
      try {
        const result = await highlightNativeReviewDiffVisibleRows({
          files: nativeReviewDiffData.files,
          rows: nativeReviewDiffData.rows,
          scheme: selectedTheme,
          engine,
          firstRowIndex: requestRange.firstRowIndex,
          lastRowIndex: requestRange.lastRowIndex,
          alreadyHighlightedRowIds: nativeHighlightedRowIdsRef.current,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted || result.rowCount === 0) {
          return;
        }

        for (const rowId of Object.keys(result.tokensByRowId)) {
          nativeHighlightedRowIdsRef.current.add(rowId);
        }

        const chunkIndex = nativeVisibleChunkIndexRef.current;
        nativeVisibleChunkIndexRef.current += 1;
        setNativeTokensPatchJson(
          JSON.stringify({
            resetKey: nativeTokensResetKey,
            chunkIndex,
            fileId: "visible",
            filePath: "visible rows",
            language: "diff",
            lineCount: result.rowCount,
            durationMs: result.durationMs,
            tokensByRowId: result.tokensByRowId,
          }),
        );
      } catch (error) {
        if (!abortController.signal.aborted) {
          logReviewDiffDiagnostic("native visible highlight failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => abortController.abort();
  }, [
    nativeReviewDiffData.files,
    nativeReviewDiffData.rows,
    nativeTokensResetKey,
    nativeVisibleHighlightRequest,
    parsedDiff.kind,
    selectedTheme,
  ]);

  useEffect(() => {
    if (parsedDiff.kind !== "files") {
      return;
    }

    markReviewEvent("parsed-diff-ready", {
      sectionId: selectedSection?.id ?? null,
      fileCount: parsedDiff.fileCount,
      additions: parsedDiff.additions,
      deletions: parsedDiff.deletions,
      renderedItems: nativeReviewDiffData.rows.length,
    });
    logReviewDiffDiagnostic("parsed diff files", {
      selectedSectionId: selectedSection?.id ?? null,
      fileCount: parsedDiff.fileCount,
      renderableFileCount: parsedDiff.files.length,
    });
  }, [nativeReviewDiffData.rows.length, parsedDiff, selectedSection?.id]);

  const refreshSelectedSection = useCallback(async () => {
    if (!selectedSection) {
      return;
    }

    if (selectedSection.kind === "turn") {
      const checkpoint = checkpointBySectionId[selectedSection.id];
      if (checkpoint) {
        await loadTurnDiff(checkpoint, true);
      }
      return;
    }

    await loadGitDiffs();
  }, [checkpointBySectionId, loadGitDiffs, loadTurnDiff, selectedSection]);

  const handleToggleExpandedFile = useCallback(
    (fileId: string) => {
      if (!selectedSection?.id || parsedDiff.kind !== "files") {
        return;
      }

      const sectionId = selectedSection.id;

      setLocalExpandedFileIdsBySection((current) => {
        const currentIds = getValidReviewExpandedFileIds(parsedDiff.files, current[sectionId]);
        const nextIds = currentIds.includes(fileId)
          ? currentIds.filter((id) => id !== fileId)
          : [...currentIds, fileId];

        return {
          ...current,
          [sectionId]: nextIds,
        };
      });

      if (reviewCache.threadKey) {
        updateReviewExpandedFileIds(reviewCache.threadKey, sectionId, (existing) => {
          const currentIds = getValidReviewExpandedFileIds(parsedDiff.files, existing);
          return currentIds.includes(fileId)
            ? currentIds.filter((id) => id !== fileId)
            : [...currentIds, fileId];
        });
      }
    },
    [parsedDiff, reviewCache.threadKey, selectedSection?.id],
  );

  const handleToggleViewedFile = useCallback(
    (fileId: string) => {
      if (!selectedSection?.id || parsedDiff.kind !== "files") {
        return;
      }

      const sectionId = selectedSection.id;
      const shouldCollapse = !viewedFileIds.includes(fileId);

      setLocalViewedFileIdsBySection((current) => {
        const currentIds = current[sectionId] ?? [];
        const nextIds = currentIds.includes(fileId)
          ? currentIds.filter((id) => id !== fileId)
          : [...currentIds, fileId];

        return {
          ...current,
          [sectionId]: nextIds,
        };
      });

      if (shouldCollapse) {
        setLocalExpandedFileIdsBySection((current) => {
          const currentIds = getValidReviewExpandedFileIds(parsedDiff.files, current[sectionId]);
          return {
            ...current,
            [sectionId]: currentIds.filter((id) => id !== fileId),
          };
        });
      }

      if (reviewCache.threadKey) {
        updateReviewViewedFileIds(reviewCache.threadKey, sectionId, (existing) => {
          const currentIds = existing ?? [];
          return currentIds.includes(fileId)
            ? currentIds.filter((id) => id !== fileId)
            : [...currentIds, fileId];
        });

        if (shouldCollapse) {
          updateReviewExpandedFileIds(reviewCache.threadKey, sectionId, (existing) => {
            const currentIds = getValidReviewExpandedFileIds(parsedDiff.files, existing);
            return currentIds.filter((id) => id !== fileId);
          });
        }
      }
    },
    [parsedDiff, reviewCache.threadKey, selectedSection?.id, viewedFileIds],
  );

  const handleNativeDebug = useCallback((event: NativeSyntheticEvent<Record<string, unknown>>) => {
    const payload = event.nativeEvent;
    const message = payload.message;
    if (
      (message === "draw-metrics" || message === "visible-range") &&
      typeof payload.firstRowIndex === "number" &&
      typeof payload.lastRowIndex === "number"
    ) {
      const previousRange = nativeVisibleRangeRef.current;
      const nextRange = {
        firstRowIndex: payload.firstRowIndex,
        lastRowIndex: payload.lastRowIndex,
      };
      const movedRows =
        Math.abs(nextRange.firstRowIndex - previousRange.firstRowIndex) +
        Math.abs(nextRange.lastRowIndex - previousRange.lastRowIndex);

      nativeVisibleRangeRef.current = nextRange;
      if (movedRows >= 20) {
        setNativeVisibleHighlightRequest((request) => request + 1);
      }
    }
  }, []);

  const handleNativeToggleFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (fileId) {
        handleToggleExpandedFile(fileId);
      }
    },
    [handleToggleExpandedFile],
  );

  const handleNativeToggleViewedFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (fileId) {
        handleToggleViewedFile(fileId);
      }
    },
    [handleToggleViewedFile],
  );

  const parsedDiffNotice =
    parsedDiff.kind === "files" || parsedDiff.kind === "raw" ? parsedDiff.notice : null;

  const listHeader = useMemo(() => {
    const children: ReactElement[] = [];

    if (error) {
      children.push(
        <View key="review-error" className="border-b border-border bg-card px-4 py-3">
          <Text className="text-[13px] font-t3-bold text-foreground">Review unavailable</Text>
          <Text className="text-[12px] leading-[18px] text-foreground-muted">{error}</Text>
        </View>,
      );
    }

    if (parsedDiffNotice) {
      children.push(<ReviewNotice key="review-notice" notice={parsedDiffNotice} />);
    }

    if (children.length === 0) {
      return null;
    }

    return <>{children}</>;
  }, [error, parsedDiffNotice]);

  return (
    <>
      <Stack.Screen
        options={{
          headerTransparent: true,
          headerShadowVisible: false,
          headerTintColor: headerIcon,
          headerStyle: {
            backgroundColor: "transparent",
          },
          headerTitle: () => (
            <View style={{ alignItems: "center" }}>
              <NativeText
                numberOfLines={1}
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 18,
                  fontWeight: "900",
                  color: headerForeground,
                  letterSpacing: -0.4,
                }}
              >
                Files Changed
              </NativeText>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {headerDiffSummary.additions && headerDiffSummary.deletions ? (
                  <>
                    <NativeText
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: "#16a34a",
                      }}
                    >
                      {headerDiffSummary.additions}
                    </NativeText>
                    <NativeText
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: "#e11d48",
                      }}
                    >
                      {headerDiffSummary.deletions}
                    </NativeText>
                    {pendingReviewCommentCount > 0 ? (
                      <NativeText
                        style={{
                          fontFamily: "DMSans_700Bold",
                          fontSize: 12,
                          fontWeight: "700",
                          color: "#b45309",
                        }}
                      >
                        {pendingReviewCommentCount} pending
                      </NativeText>
                    ) : null}
                  </>
                ) : (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <NativeText
                      numberOfLines={1}
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: headerMuted,
                      }}
                    >
                      {selectedSection?.title ?? "Review changes"}
                    </NativeText>
                    {pendingReviewCommentCount > 0 ? (
                      <NativeText
                        style={{
                          fontFamily: "DMSans_700Bold",
                          fontSize: 12,
                          fontWeight: "700",
                          color: "#b45309",
                        }}
                      >
                        {pendingReviewCommentCount} pending
                      </NativeText>
                    ) : null}
                  </View>
                )}
              </View>
            </View>
          ),
        }}
      />

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis.circle" title="Select diff" separateBackground>
          {reviewSections.map((section) => (
            <Stack.Toolbar.MenuAction
              key={section.id}
              icon={section.id === selectedSection?.id ? "checkmark" : "circle"}
              onPress={() => {
                if (reviewCache.threadKey) {
                  setReviewSelectedSectionId(reviewCache.threadKey, section.id);
                }
              }}
              subtitle={section.subtitle ?? undefined}
            >
              <Stack.Toolbar.Label>{section.title}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          ))}
          <Stack.Toolbar.MenuAction
            icon="arrow.clockwise"
            disabled={
              loadingGitDiffs ||
              (selectedSection?.kind === "turn" && loadingTurnIds[selectedSection.id] === true)
            }
            onPress={() => void refreshSelectedSection()}
            subtitle="Reload current diff"
          >
            <Stack.Toolbar.Label>Refresh</Stack.Toolbar.Label>
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <View className="flex-1 bg-sheet">
        {selectedSection && parsedDiff.kind === "files" ? (
          <View
            className="flex-1"
            style={{
              backgroundColor: nativeReviewDiffTheme.background,
              paddingTop: topContentInset + REVIEW_HEADER_SPACING,
            }}
          >
            {listHeader}
            <View className="flex-1" collapsable={false}>
              <NativeReviewDiffView
                key={`${reviewCache.threadKey}:${selectedSection.id}`}
                collapsable={false}
                testID="review-native-diff-view"
                style={StyleSheet.absoluteFillObject}
                appearanceScheme={selectedTheme}
                collapsedFileIdsJson={nativeCollapsedFileIdsJson}
                contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
                rowHeight={NATIVE_REVIEW_DIFF_ROW_HEIGHT}
                rowsJson={nativeRowsJson}
                styleJson={nativeStyleJson}
                themeJson={nativeThemeJson}
                tokensPatchJson={nativeTokensPatchJson}
                tokensResetKey={nativeTokensResetKey}
                viewedFileIdsJson={nativeViewedFileIdsJson}
                onDebug={handleNativeDebug}
                onToggleFile={handleNativeToggleFile}
                onToggleViewedFile={handleNativeToggleViewedFile}
              />
            </View>
          </View>
        ) : (
          <ScrollView
            contentInsetAdjustmentBehavior="never"
            contentInset={{ top: topContentInset }}
            contentOffset={{ x: 0, y: -topContentInset }}
            scrollIndicatorInsets={{ top: topContentInset }}
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingTop: REVIEW_HEADER_SPACING,
              paddingBottom: Math.max(insets.bottom, 18) + 18,
            }}
          >
            {listHeader}
            {!selectedSection ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-[14px] font-t3-bold text-foreground">No review diffs</Text>
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  This thread has no ready turn diffs and the worktree diff is empty.
                </Text>
              </View>
            ) : selectedSection.isLoading && selectedSection.diff === null ? (
              <View className="items-center gap-3 border-b border-border bg-card px-4 py-6">
                <ActivityIndicator size="small" />
                <Text className="text-[12px] text-foreground-muted">Loading diff…</Text>
              </View>
            ) : parsedDiff.kind === "empty" ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-[14px] font-t3-bold text-foreground">No changes</Text>
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  {selectedSection.subtitle ?? "This diff is empty."}
                </Text>
              </View>
            ) : parsedDiff.kind === "raw" ? (
              <View className="gap-3 border-b border-border bg-card px-4 py-4">
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  {parsedDiff.reason}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                  <Text selectable className="font-mono text-[12px] leading-[19px] text-foreground">
                    {parsedDiff.text}
                  </Text>
                </ScrollView>
              </View>
            ) : null}
          </ScrollView>
        )}
      </View>
    </>
  );
}
