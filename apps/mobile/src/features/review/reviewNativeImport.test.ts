import { afterAll, beforeAll, expect, it } from "@effect/vitest";

const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
const originalCustomElements = Object.getOwnPropertyDescriptor(globalThis, "customElements");

beforeAll(() => {
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: Object,
  });
  Reflect.deleteProperty(globalThis, "customElements");
});

afterAll(() => {
  if (originalHTMLElement) {
    Object.defineProperty(globalThis, "HTMLElement", originalHTMLElement);
  } else {
    Reflect.deleteProperty(globalThis, "HTMLElement");
  }

  if (originalCustomElements) {
    Object.defineProperty(globalThis, "customElements", originalCustomElements);
  } else {
    Reflect.deleteProperty(globalThis, "customElements");
  }
});

it("loads review modules when React Native provides HTMLElement without customElements", async () => {
  const modules = await Promise.all([import("./reviewModel"), import("./shikiReviewHighlighter")]);

  expect(modules).toHaveLength(2);
});
