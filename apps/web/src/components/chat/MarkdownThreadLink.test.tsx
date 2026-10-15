import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { ThreadLinkEnvironment } from "@t3tools/client-runtime/state/thread-link-resolution";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const devVm = EnvironmentId.make("dev-vm");
const mac = EnvironmentId.make("local-mbp");

const fixture = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<unknown>,
  projects: new Map<string, { title: string }>(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    title,
    children,
    ...rest
  }: {
    to: string;
    params: Record<string, string>;
    title?: string;
    children: ReactNode;
  }) => (
    <a href={to} data-params={JSON.stringify(params)} data-title={title} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
// The component reads the project and the link target; the resolver itself is the real one.
vi.mock("../../state/entities", () => ({
  useProject: (ref: { environmentId: string; projectId: string } | null) =>
    ref === null ? null : (fixture.projects.get(`${ref.environmentId}/${ref.projectId}`) ?? null),
}));
vi.mock("../../state/threadLinks", async () => {
  const { resolveThreadAcrossEnvironments } =
    await import("@t3tools/client-runtime/state/thread-link-resolution");
  return {
    useThreadLink: (preferredEnvironmentId: string, threadId: string) =>
      resolveThreadAcrossEnvironments({
        threadId: threadId as never,
        preferredEnvironmentId: preferredEnvironmentId as never,
        environments: fixture.environments as never,
      }),
  };
});

import { MarkdownThreadLink } from "./MarkdownThreadLink";

function shell(id: string, title: string, projectId: string): OrchestrationV2ThreadShell {
  return { id: ThreadId.make(id), title, projectId: ProjectId.make(projectId) } as never;
}

function environment(
  environmentId: EnvironmentId,
  label: string,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  state: "live" | "disconnected" = "live",
): ThreadLinkEnvironment<OrchestrationV2ThreadShell> {
  return {
    environmentId,
    label,
    live: state === "live",
    connecting: false,
    threads: new Map(threads.map((thread) => [thread.id, thread] as const)),
  };
}

let tree: ReactTestRenderer | null = null;
function render(threadId: string, label = "the label") {
  act(() => {
    tree = create(
      <MarkdownThreadLink environmentId={devVm} threadId={ThreadId.make(threadId)} label={label} />,
    );
  });
  const anchor = tree!.root.find((node) => node.type === "a");
  return {
    params: JSON.parse(anchor.props["data-params"] as string) as Record<string, string>,
    title: anchor.props["data-title"] as string | undefined,
    copy: anchor.props["data-markdown-copy"] as string,
    text: JSON.stringify(tree!.toJSON()),
  };
}

beforeEach(() => {
  fixture.projects.clear();
  fixture.projects.set("dev-vm/project-a", { title: "Dev project" });
  fixture.projects.set("local-mbp/project-b", { title: "Mac project" });
  fixture.environments = [
    environment(devVm, "Dev VM", [shell("source", "Source thread", "project-a")]),
    environment(mac, "Mac", [shell("target", "Target on the Mac", "project-b")]),
  ];
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe("MarkdownThreadLink", () => {
  it("opens a thread that lives in another environment with that environment's scope", () => {
    const link = render("target");
    expect(link.params).toEqual({ environmentId: "local-mbp", threadId: "target" });
    expect(link.title).toBe("Mac project · Mac");
    expect(link.text).toContain("Target on the Mac");
    expect(link.copy).toBe("[Target on the Mac](t3-thread://v1/target)");
  });

  it("keeps a same-environment link as it was: its own scope and just the project title", () => {
    const link = render("source");
    expect(link.params).toEqual({ environmentId: "dev-vm", threadId: "source" });
    expect(link.title).toBe("Dev project");
  });

  it("says a thread is missing only once every machine answered", () => {
    const link = render("gone");
    expect(link.title).toBe("Not found on any connected machine (it may be archived)");
    expect(link.text).toContain("the label");
    expect(link.params).toEqual({ environmentId: "dev-vm", threadId: "gone" });
  });

  it("names a disconnected machine instead of calling the thread missing", () => {
    fixture.environments = [
      environment(devVm, "Dev VM", []),
      environment(mac, "Mac", [], "disconnected"),
    ];
    expect(render("gone").title).toBe("Mac is disconnected");
  });

  it("follows a decoded opaque id into the other environment", () => {
    fixture.environments = [
      environment(devVm, "Dev VM", []),
      environment(mac, "Mac", [shell("mcp:abc", "Opaque", "project-b")]),
    ];
    const link = render("mcp%3Aabc");
    expect(link.params).toEqual({ environmentId: "local-mbp", threadId: "mcp:abc" });
    expect(link.copy).toBe("[Opaque](t3-thread://v1/mcp:abc)");
  });

  it("does not guess between machines that both hold the id", () => {
    fixture.environments = [
      environment(devVm, "Dev VM", []),
      environment(mac, "Mac", [shell("dup", "Dup", "project-b")]),
      environment(EnvironmentId.make("laptop"), "Laptop", [shell("dup", "Dup", "project-b")]),
    ];
    const link = render("dup");
    // A focusable link that opens the message's own machine rather than guessing a holder.
    expect(link.params).toEqual({ environmentId: "dev-vm", threadId: "dup" });
    expect(link.title).toBe("On several machines: Mac, Laptop");
  });
});
