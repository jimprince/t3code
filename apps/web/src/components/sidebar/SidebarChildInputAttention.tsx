import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { MessageCircleQuestionIcon } from "lucide-react";

export function SidebarChildInputAttention(props: {
  children: ReadonlyArray<EnvironmentThreadShell>;
  onOpen: (child: EnvironmentThreadShell) => void;
}) {
  const child = props.children[0];
  if (!child) return null;
  const label = `${props.children.length} sub-agent${props.children.length === 1 ? "" : "s"} need${props.children.length === 1 ? "s" : ""} input`;
  return (
    <button
      type="button"
      aria-label={`Open ${label}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen(child);
      }}
      className="inline-flex shrink-0 items-center gap-1 text-xs text-info"
    >
      <MessageCircleQuestionIcon aria-hidden className="size-3" />
      {label}
    </button>
  );
}
