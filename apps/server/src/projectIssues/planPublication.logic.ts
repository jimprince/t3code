import * as NodeCrypto from "node:crypto";

export interface PlanTask {
  readonly key: string;
  readonly title: string;
  readonly owner: string;
  readonly detail: string;
}

/** Top-level list items are tasks; indented bullets stay in the task's detail. */
export function parsePlanTasks(markdown: string, defaultOwner: string): readonly PlanTask[] {
  const tasks: Array<{ key: string; title: string; owner: string; lines: string[] }> = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (tasks.length) tasks.at(-1)!.lines.push(line);
      continue;
    }
    const item = !inFence ? /^(?:[-*+] |\d+[.)] )(?:\[[ xX]\]\s*)?(.+)$/.exec(line) : null;
    if (item) {
      const marker = /\s*<!--\s*task:([a-zA-Z0-9_-]+)\s*-->\s*$/.exec(item[1]!);
      const title = (marker ? item[1]!.slice(0, marker.index) : item[1]!).trim();
      tasks.push({
        key: marker?.[1] ?? String(tasks.length + 1),
        title,
        owner: defaultOwner,
        lines: [],
      });
    } else if (tasks.length) {
      const owner = /^\s+Owner:\s*(\S.*)$/i.exec(line);
      if (owner && !inFence) tasks.at(-1)!.owner = owner[1]!.trim();
      else tasks.at(-1)!.lines.push(line);
    }
  }
  if (tasks.length === 0 || tasks.length > 100)
    throw new Error("A plan must contain 1 to 100 top-level list tasks.");
  const keys = new Set<string>();
  return tasks.map(({ lines, ...task }) => {
    if (!task.title || task.title.length > 200 || !task.owner || task.owner.length > 200) {
      throw new Error("Each task needs a title and owner of at most 200 characters.");
    }
    if (keys.has(task.key)) throw new Error(`Duplicate task key: ${task.key}`);
    keys.add(task.key);
    return { ...task, detail: lines.join("\n").trim() };
  });
}

export function publicationMarker(key: string) {
  return `<!-- t3-plan:${NodeCrypto.createHash("sha256").update(key).digest("hex")} -->`;
}
export function taskPublicationMarker(marker: string, taskKey: string) {
  return marker.replace(" -->", `:task:${taskKey} -->`);
}
