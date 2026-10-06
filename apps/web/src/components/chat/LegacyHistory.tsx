import type { EnvironmentId, LegacyHistorySection, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { legacyHistoryQuery } from "../../state/legacyHistory";
import ChatMarkdown from "../ChatMarkdown";
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
  describeLegacyRecord,
  diffLineTone,
  formatLegacyTimestamp,
  legacyHistoryPageSize,
  legacyHistorySectionLabel,
  legacyHistoryTitle,
  orderLegacyHistorySections,
  type LegacyHistoryRow,
} from "./legacyHistory.logic";

const INLINE_BODY_SECTIONS: ReadonlySet<LegacyHistorySection> = new Set([
  "messages",
  "plans",
  "goals",
]);
const MARKDOWN_SECTIONS: ReadonlySet<LegacyHistorySection> = new Set(["messages", "plans"]);

const DIFF_TONE_CLASS = {
  add: "text-success",
  remove: "text-destructive",
  hunk: "font-medium",
} as const;

function LegacyHistoryBody({
  section,
  body,
}: {
  readonly section: LegacyHistorySection;
  readonly body: string;
}) {
  if (MARKDOWN_SECTIONS.has(section)) return <ChatMarkdown text={body} cwd={undefined} />;
  if (section === "diffs") {
    return (
      <pre className="overflow-x-auto whitespace-pre font-mono text-xs">
        {body.split("\n").map((line, index) => {
          const tone = diffLineTone(line);
          return (
            <span
              key={index}
              className={tone === null ? "block" : `block ${DIFF_TONE_CLASS[tone]}`}
            >
              {line.length > 0 ? line : " "}
            </span>
          );
        })}
      </pre>
    );
  }
  return (
    <pre
      className={
        INLINE_BODY_SECTIONS.has(section)
          ? "whitespace-pre-wrap break-words font-mono text-xs"
          : "overflow-x-auto whitespace-pre font-mono text-xs"
      }
    >
      {body}
    </pre>
  );
}

function LegacyHistoryRowView({
  section,
  row,
}: {
  readonly section: LegacyHistorySection;
  readonly row: LegacyHistoryRow;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [open, setOpen] = useState(false);
  const at = formatLegacyTimestamp(row.at, timestampFormat);
  const body = row.body === null ? null : <LegacyHistoryBody section={section} body={row.body} />;
  return (
    <li className="flex flex-col gap-1 border-b border-border py-2">
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="min-w-0 truncate font-medium">{row.label}</span>
        {row.detail !== null ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{row.detail}</span>
        ) : null}
        {at !== null ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{at}</span>
        ) : null}
      </div>
      {body === null ? null : INLINE_BODY_SECTIONS.has(section) ? (
        body
      ) : (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            {open ? "Hide" : "Show"}
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
      input: { threadId, section, offset, limit: legacyHistoryPageSize(section) },
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
                section={section}
                row={row}
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
  const title = legacyHistoryTitle(probe.data.origin);
  return (
    <Dialog>
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>{title}</DialogTrigger>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title} (read-only)</DialogTitle>
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
