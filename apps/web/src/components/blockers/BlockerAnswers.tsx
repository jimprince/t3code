import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { useDecisionAnswers, type DecisionAnswers } from "../dashboard-v3/useDecisionAnswers";

export interface BlockerAnswersHost {
  readonly answers: DecisionAnswers;
  /** A surface reports the decisions it lists, so a delivered answer stays answered while it lags. */
  readonly report: (owner: string, keys: ReadonlySet<string> | null) => void;
}

const BlockerAnswersContext = createContext<BlockerAnswersHost | null>(null);

function OwnedAnswers({ children }: { readonly children: ReactNode }) {
  const answers = useDecisionAnswers();
  const reported = useRef(new Map<string, ReadonlySet<string>>());
  const reconcile = answers.reconcile;
  const report = useCallback(
    (owner: string, keys: ReadonlySet<string> | null) => {
      if (keys) reported.current.set(owner, keys);
      else reported.current.delete(owner);
      reconcile(new Set([...reported.current.values()].flatMap((entry) => [...entry])));
    },
    [reconcile],
  );
  const host = useMemo(() => ({ answers, report }), [answers, report]);
  return <BlockerAnswersContext value={host}>{children}</BlockerAnswersContext>;
}

/**
 * The one answers hook for every surface that can answer a decision: the sidebar, a project page,
 * the Dashboard and the Chief of Staff pin. One Undo hold and one record per decision means a
 * decision answered anywhere shows its receipt everywhere, and cannot be answered a second time.
 * The app shell mounts it; a surface rendered on its own (a test, an embed) nests one that defers
 * to any provider above it.
 */
export function BlockerAnswersProvider({ children }: { readonly children: ReactNode }) {
  const outer = use(BlockerAnswersContext);
  return outer ? children : <OwnedAnswers>{children}</OwnedAnswers>;
}

/** The shared host, or null when nothing above mounts a provider. */
export function useAnswersHost(): BlockerAnswersHost | null {
  return use(BlockerAnswersContext);
}

/**
 * The shared answers for a surface that lists `openKeys`. Throws when no provider is above it:
 * a surface that owned its own answers is exactly the double-answer bug.
 */
export function useSharedAnswers(openKeys: ReadonlySet<string>): DecisionAnswers {
  const host = use(BlockerAnswersContext);
  if (!host) throw new Error("Mount BlockerAnswersProvider above any surface that answers.");
  const owner = useId();
  const { report } = host;
  useEffect(() => {
    report(owner, openKeys);
    return () => report(owner, null);
  }, [report, owner, openKeys]);
  return host.answers;
}
