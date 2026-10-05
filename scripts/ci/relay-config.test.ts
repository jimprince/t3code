import { describe, expect, it } from "vite-plus/test";
import { relayConfigured, requiredRelayConfig } from "./relay-config.ts";

describe("relay deployment config", () => {
  it("skips empty and rejects partial config without exposing values", () => {
    expect(relayConfigured({})).toBe(false);
    expect(() => relayConfigured({ CLOUDFLARE_API_TOKEN: "secret-value" })).toThrow("Missing:");
    expect(() => relayConfigured({ CLOUDFLARE_API_TOKEN: "secret-value" })).not.toThrow(
      "secret-value",
    );
  });
  it("deploys complete config", () => {
    expect(
      relayConfigured(Object.fromEntries(requiredRelayConfig.map((key) => [key, "value"]))),
    ).toBe(true);
  });
});
