import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import {
  defaultEpic,
  filingInput,
  IMAGE_ONLY_TITLE,
  kindFromText,
  nextKeyHint,
  placementOf,
} from "./requestLine.logic";

const key = (extra: Partial<Parameters<typeof placementOf>[0]> = {}) => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...extra,
});

describe("placementOf", () => {
  it("files last on Enter and next on Cmd or Ctrl with Enter", () => {
    expect(placementOf(key())).toBe("last");
    expect(placementOf(key({ metaKey: true }))).toBe("next");
    expect(placementOf(key({ ctrlKey: true }))).toBe("next");
  });

  it("leaves Shift+Enter, IME composition and other keys alone", () => {
    expect(placementOf(key({ shiftKey: true }))).toBeNull();
    expect(placementOf(key({ isComposing: true }))).toBeNull();
    expect(placementOf(key({ key: "a", metaKey: true }))).toBeNull();
  });
});

describe("kindFromText", () => {
  it("selects bug for a Bug: or Fix lead and nothing else", () => {
    expect(kindFromText("Bug: the box loses my text")).toBe("bug");
    expect(kindFromText("  fix the drag handle")).toBe("bug");
    expect(kindFromText("Fixture cleanup")).toBeNull();
    expect(kindFromText("Add a bug report button")).toBeNull();
  });
});

describe("defaultEpic", () => {
  it("returns the last-used workstream only while it still exists", () => {
    expect(defaultEpic([300, 297], 297)).toBe(297);
    expect(defaultEpic([300], 297)).toBeNull();
    expect(defaultEpic([300], undefined)).toBeNull();
  });
});

describe("nextKeyHint", () => {
  it("names the chord for the platform", () => {
    expect(nextKeyHint("MacIntel")).toBe("⌘Enter");
    expect(nextKeyHint("Linux x86_64")).toBe("Ctrl+Enter");
  });
});

describe("filingInput", () => {
  const base = {
    threadId: ThreadId.make("root"),
    kind: "task" as const,
    epic: null,
    placement: "last" as const,
    messageId: "m1",
  };

  it("files Brad's own words placed last, with his actor and the retry id", () => {
    expect(filingInput({ ...base, text: "  Widen the plan  " })).toEqual({
      threadId: "root",
      title: "Widen the plan",
      kind: "task",
      place: { to: "bottom" },
      actor: "brad",
      messageId: "m1",
    });
  });

  it("keeps all the words as the detail when they run past the title line", () => {
    const input = filingInput({
      ...base,
      text: "Bug: drag drops wrong\nit lands one row up",
      kind: "bug",
      epic: 300,
      placement: "next",
    });
    expect(input).toMatchObject({
      title: "Bug: drag drops wrong",
      detail: "Bug: drag drops wrong\nit lands one row up",
      bug: true,
      kind: "task",
      partOf: 300,
      place: { to: "top" },
    });
  });

  it("files an epic with no parent epic", () => {
    const input = filingInput({ ...base, text: "Mobile order", kind: "epic", epic: 300 });
    expect(input.kind).toBe("epic");
    expect(input).not.toHaveProperty("partOf");
  });

  it("carries uploaded images, and files images alone under the old box's title", () => {
    const image = {
      id: "a1",
      type: "image" as const,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 12,
    };
    const input = filingInput({ ...base, text: "  ", attachments: [image] });
    expect(input.title).toBe(IMAGE_ONLY_TITLE);
    expect(input).not.toHaveProperty("detail");
    expect(input.attachments).toEqual([image]);
    expect(filingInput({ ...base, text: "Words" })).not.toHaveProperty("attachments");
  });
});
