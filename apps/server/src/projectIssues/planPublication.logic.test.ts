import { describe, expect, it } from "vite-plus/test";
import {
  parsePlanTasks,
  publicationMarker,
  taskPublicationMarker,
} from "./planPublication.logic.ts";

describe("plan task parsing", () => {
  it("parses ordered, unchecked and checked tasks, preserving nested detail and explicit owners", () => {
    const tasks = parsePlanTasks(
      "# Approved\n1. [ ] Parse <!-- task:parser -->\n  Owner: Specialist\n  - Keep nested detail\n2. [x] Render\n  Show output.",
      "Manager",
    );
    expect(tasks).toEqual([
      { key: "parser", title: "Parse", owner: "Specialist", detail: "- Keep nested detail" },
      { key: "2", title: "Render", owner: "Manager", detail: "Show output." },
    ]);
  });
  it("ignores list syntax inside fenced code and rejects empty or ambiguous task lists", () => {
    expect(parsePlanTasks("```\n- Example\n```\n- Real task", "Owner")).toEqual([
      { key: "1", title: "Real task", owner: "Owner", detail: "" },
    ]);
    expect(() => parsePlanTasks("Just prose", "Owner")).toThrow("1 to 100");
    expect(() =>
      parsePlanTasks("- First <!-- task:same -->\n- Second <!-- task:same -->", "Owner"),
    ).toThrow("Duplicate task key");
  });
  it("keeps publication identity stable across edits and distinguishes task identities", () => {
    const marker = publicationMarker("source");
    expect(marker).toBe(publicationMarker("source"));
    expect(marker).not.toBe(publicationMarker("another"));
    expect(taskPublicationMarker(marker, "a")).not.toBe(taskPublicationMarker(marker, "b"));
  });
});
