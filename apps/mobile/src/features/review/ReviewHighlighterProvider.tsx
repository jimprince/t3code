import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import {
  getActiveReviewHighlighterEngine,
  prepareReviewHighlighter,
  prepareReviewHighlighterLanguages,
  type ReviewHighlighterEngine,
} from "./shikiReviewHighlighter";

type ReviewHighlighterStatus = "idle" | "initializing" | "ready" | "error";

interface ReviewHighlighterContextValue {
  readonly engine: ReviewHighlighterEngine | null;
  readonly error: string | null;
  readonly status: ReviewHighlighterStatus;
}

const ReviewHighlighterContext = createContext<ReviewHighlighterContextValue>({
  engine: null,
  error: null,
  status: "idle",
});

const REVIEW_INITIAL_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "yaml",
  "bash",
] as const;

function isReviewHighlighterProviderDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewHighlighterProviderDiagnostic(
  message: string,
  details?: Record<string, unknown>,
): void {
  if (!isReviewHighlighterProviderDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-highlighter-provider] ${message}`, details);
    return;
  }

  console.log(`[review-highlighter-provider] ${message}`);
}

export function ReviewHighlighterProvider(props: { readonly children: ReactNode }) {
  const [value, setValue] = useState<ReviewHighlighterContextValue>({
    engine: null,
    error: null,
    status: "idle",
  });

  useEffect(() => {
    let cancelled = false;

    setValue({ engine: null, error: null, status: "initializing" });

    void (async () => {
      const startedAt = performance.now();
      try {
        await prepareReviewHighlighter();
        await prepareReviewHighlighterLanguages(REVIEW_INITIAL_LANGUAGES);
        const engine = await getActiveReviewHighlighterEngine();

        if (cancelled) {
          return;
        }

        const durationMs = Math.round(performance.now() - startedAt);
        logReviewHighlighterProviderDiagnostic("initialized", {
          durationMs,
          engine,
        });
        setValue({ engine, error: null, status: "ready" });
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        logReviewHighlighterProviderDiagnostic("initialization failed", { error: message });
        setValue({ engine: null, error: message, status: "error" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const contextValue = useMemo(() => value, [value]);

  return (
    <ReviewHighlighterContext.Provider value={contextValue}>
      {props.children}
    </ReviewHighlighterContext.Provider>
  );
}

export function useReviewHighlighterStatus(): ReviewHighlighterContextValue {
  return useContext(ReviewHighlighterContext);
}
