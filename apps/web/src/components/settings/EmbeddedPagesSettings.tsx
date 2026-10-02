import { EmbeddedPage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import {
  DEFAULT_EMBEDDED_PAGE_ICON,
  EMBEDDED_PAGE_ICONS,
  EmbeddedPageIcon,
} from "../embeddedPages/embeddedPageIcons";
import { moveEmbeddedPage } from "../embeddedPages/embeddedPages.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection } from "./settingsLayout";

const decodeEmbeddedPage = Schema.decodeUnknownOption(EmbeddedPage);

function EmbeddedPageForm({
  page,
  index,
  count,
  save,
  move,
  remove,
}: {
  page: EmbeddedPage;
  index: number;
  count: number;
  save: (value: EmbeddedPage) => void;
  move: ((direction: -1 | 1) => void) | null;
  remove: () => void;
}) {
  const [icon, setIcon] = useState(page.icon);
  const [error, setError] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-4 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const value = decodeEmbeddedPage({
          id: page.id,
          name: String(data.get("name") ?? "").trim(),
          url: String(data.get("url") ?? "").trim(),
          icon,
        });
        if (value._tag === "None") {
          setError("Enter a name and a full http:// or https:// URL.");
          return;
        }
        setError("");
        save(value.value);
      }}
    >
      <Select value={icon} onValueChange={(value) => value && setIcon(value)}>
        <SelectTrigger size="compact" className="w-16 min-w-0" aria-label="Icon">
          <SelectValue>
            <EmbeddedPageIcon icon={icon} className="size-4" />
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {EMBEDDED_PAGE_ICONS.map(({ id, label, Icon: OptionIcon }) => (
            <SelectItem key={id} value={id}>
              <span className="flex items-center gap-2">
                <OptionIcon className="size-4" />
                {label}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Input
        name="name"
        aria-label="Name"
        className="w-40"
        defaultValue={page.name}
        placeholder="Name"
        required
      />
      <Input
        name="url"
        aria-label="URL"
        className="min-w-56 flex-1"
        defaultValue={page.url}
        placeholder="https://status.example"
        required
      />
      <Button type="submit" size="sm" variant="outline">
        Save
      </Button>
      {move ? (
        <>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Move up"
            disabled={index === 0}
            onClick={() => move(-1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Move down"
            disabled={index === count - 1}
            onClick={() => move(1)}
          >
            <ArrowDownIcon />
          </Button>
        </>
      ) : null}
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove" onClick={remove}>
        <Trash2Icon />
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Settings → General: the web pages shown as sidebar footer icons. */
export function EmbeddedPagesSettingsSection() {
  const embeddedPages = usePrimarySettings((settings) => settings.embeddedPages);
  const update = useUpdatePrimarySettings();
  const [draft, setDraft] = useState<EmbeddedPage | null>(null);
  const write = (next: readonly EmbeddedPage[]) => update({ embeddedPages: [...next] });
  return (
    <SettingsSection id="embedded-pages" title="Sidebar pages">
      <p className="px-4 pt-3 text-sm text-muted-foreground">
        Web pages that open from an icon in the sidebar footer. Synced to every connected
        environment.
      </p>
      {embeddedPages.map((page, index) => (
        <EmbeddedPageForm
          key={`${page.id}:${page.name}:${page.url}:${page.icon}`}
          page={page}
          index={index}
          count={embeddedPages.length}
          save={(value) =>
            write(embeddedPages.map((item) => (item.id === value.id ? value : item)))
          }
          move={(direction) => write(moveEmbeddedPage(embeddedPages, index, direction))}
          remove={() => write(embeddedPages.filter((item) => item.id !== page.id))}
        />
      ))}
      {draft ? (
        <EmbeddedPageForm
          key={draft.id}
          page={draft}
          index={embeddedPages.length}
          count={embeddedPages.length + 1}
          save={(value) => {
            write([...embeddedPages, value]);
            setDraft(null);
          }}
          move={null}
          remove={() => setDraft(null)}
        />
      ) : null}
      <div className="px-4 pb-3">
        <Button
          variant="outline"
          size="sm"
          disabled={draft !== null}
          onClick={() =>
            setDraft({ id: randomUUID(), name: "", url: "", icon: DEFAULT_EMBEDDED_PAGE_ICON })
          }
        >
          Add page
        </Button>
      </div>
    </SettingsSection>
  );
}
