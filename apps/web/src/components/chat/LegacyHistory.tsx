import type { EnvironmentId, LegacyHistorySection, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { legacyHistoryQuery } from "../../state/legacyHistory";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  LEGACY_HISTORY_PAGE_SIZE,
  describeLegacyRecord,
  legacyHistorySectionLabel,
  orderLegacyHistorySections,
  type LegacyHistoryRow,
} from "./legacyHistory.logic";

const INLINE_BODY_SECTIONS: ReadonlySet<LegacyHistorySection> = new Set([
  "messages",
  "plans",
  "goals",
]);

function LegacyHistoryRowView({
  row,
  inlineBody,
}: {
  readonly row: LegacyHistoryRow;
  readonly inlineBody: boolean;
}) {
  const body =
    row.body === null ? null : (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs">{row.body}</pre>
    );
  return (
    <li className="flex flex-col gap-1 border-b border-border py-2">
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="min-w-0 truncate font-medium">{row.label}</span>
        {row.detail !== null ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{row.detail}</span>
        ) : null}
        {row.at !== null ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{row.at}</span>
        ) : null}
      </div>
      {body === null ? null : inlineBody ? (
        body
      ) : (
        <Collapsible>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            Show
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>{body}</CollapsiblePanel>
        </Collapsible>
      )}
    </li>
  );
}

function LegacyHistoryPage({
  environmentId,
  threadId,
  section,
  offset,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly section: LegacyHistorySection;
  readonly offset: number;
}) {
  const [showMore, setShowMore] = useState(false);
  const query = useEnvironmentQuery(
    legacyHistoryQuery({
      environmentId,
      input: { threadId, section, offset, limit: LEGACY_HISTORY_PAGE_SIZE },
    }),
  );
  if (query.data === null) {
    return query.error !== null ? (
      <div className="flex items-center gap-2 py-2 text-sm">
        <span className="min-w-0 flex-1">{query.error}</span>
        <Button size="xs" variant="outline" onClick={query.refresh}>
          Retry
        </Button>
      </div>
    ) : (
      <p className="py-2 text-sm">Loading</p>
    );
  }
  const { records, nextOffset } = query.data;
  return (
    <>
      {records.length === 0 && offset === 0 ? <p className="py-2 text-sm">No records</p> : null}
      {records.length > 0 ? (
        <ul>
          {records.map((record, index) => {
            const row = describeLegacyRecord(section, record, offset + index);
            return (
              <LegacyHistoryRowView
                key={`${row.key}:${offset + index}`}
                row={row}
                inlineBody={INLINE_BODY_SECTIONS.has(section)}
              />
            );
          })}
        </ul>
      ) : null}
      {nextOffset === null ? null : showMore ? (
        <LegacyHistoryPage
          environmentId={environmentId}
          threadId={threadId}
          section={section}
          offset={nextOffset}
        />
      ) : (
        <Button size="xs" variant="outline" onClick={() => setShowMore(true)}>
          Show more
        </Button>
      )}
    </>
  );
}

/**
 * Header action for threads imported from V1. It stays hidden until the server reports
 * historical sections, and the view it opens has no restore or goal controls.
 */
export function LegacyHistoryButton({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const probe = useEnvironmentQuery(
    legacyHistoryQuery({ environmentId, input: { threadId, section: "thread", limit: 1 } }),
  );
  const [chosen, setChosen] = useState<LegacyHistorySection | null>(null);
  const sections = orderLegacyHistorySections(probe.data?.sections ?? []);
  const section = chosen !== null && sections.includes(chosen) ? chosen : sections[0];
  if (probe.data === null || section === undefined) return null;
  return (
    <Dialog>
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>V1 history</DialogTrigger>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>V1 history (read-only)</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {probe.data.sourceThreadId !== threadId ? (
            <p className="text-xs">Inherited from the parent thread.</p>
          ) : null}
          <ToggleGroup
            aria-label="History section"
            variant="segmented"
            value={[section]}
            onValueChange={(next) => {
              const value = sections.find((candidate) => candidate === next[0]);
              if (value !== undefined) setChosen(value);
            }}
          >
            {sections.map((candidate) => (
              <Toggle key={candidate} value={candidate}>
                {legacyHistorySectionLabel(candidate)}
              </Toggle>
            ))}
          </ToggleGroup>
          <LegacyHistoryPage
            key={section}
            environmentId={environmentId}
            threadId={threadId}
            section={section}
            offset={0}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
