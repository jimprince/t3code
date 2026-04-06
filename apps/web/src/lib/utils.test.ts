import { afterEach, beforeEach, describe, assert, it, vi } from "vitest";

import { isWindowsPlatform, resolveServerHttpUrl, resolveServerUrl } from "./utils";

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

const originalWindow = globalThis.window;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:5735",
        hostname: "localhost",
        port: "5735",
        protocol: "http:",
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("resolveServerHttpUrl", () => {
  it("uses the Vite dev origin for local HTTP requests automatically", () => {
    vi.stubEnv("VITE_WS_URL", "ws://127.0.0.1:3775/ws");

    assert.equal(
      resolveServerHttpUrl({ pathname: "/api/observability/v1/traces" }),
      "http://localhost:5735/api/observability/v1/traces",
    );
  });
});

describe("resolveServerUrl", () => {
  it("keeps the backend origin for websocket requests", () => {
    vi.stubEnv("VITE_WS_URL", "ws://127.0.0.1:3775/ws");

    assert.equal(
      resolveServerUrl({
        protocol: "ws",
        pathname: "/ws",
      }),
      "ws://127.0.0.1:3775/ws",
    );
  });
});
