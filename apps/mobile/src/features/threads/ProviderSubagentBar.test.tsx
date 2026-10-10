import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: "div",
  Pressable: ({ children, onPress }: { children: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));

import { ProviderSubagentBar } from "./ProviderSubagentBar";

const render = (props: {
  onOpenParent: (() => void) | null;
  onBackToProject?: (() => void) | null;
}) =>
  renderToStaticMarkup(
    <ProviderSubagentBar
      provider={null}
      modelLabel="Sonnet"
      effortLabel={null}
      status={null}
      {...props}
    />,
  );

describe("ProviderSubagentBar", () => {
  it("offers Back to project beside Open parent for a subagent of a worker", () => {
    const markup = render({ onOpenParent: vi.fn(), onBackToProject: vi.fn() });
    expect(markup).toContain("Back to project");
    expect(markup).toContain("Open parent");
    expect(markup.indexOf("Back to project")).toBeLessThan(markup.indexOf("Open parent"));
  });

  it("shows only Open parent when the parent is the project", () => {
    const markup = render({ onOpenParent: vi.fn(), onBackToProject: null });
    expect(markup).toContain("Open parent");
    expect(markup).not.toContain("Back to project");
  });
});
