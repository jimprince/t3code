import { useAtomValue } from "@effect/atom-react";
import { resolveEmbeddedPages, type EmbeddedPage } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironments } from "~/state/environments";
import { primaryServerConfigAtom } from "~/state/server";

/** The sidebar footer pages this client shows, from the shared `embeddedPages` setting. */
export function useEmbeddedPages(): readonly EmbeddedPage[] {
  const primarySettings = useAtomValue(primaryServerConfigAtom)?.settings ?? null;
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      resolveEmbeddedPages(
        primarySettings,
        environments.map((environment) => environment.serverConfig?.settings ?? null),
      ),
    [environments, primarySettings],
  );
}
