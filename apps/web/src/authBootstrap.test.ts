import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

type TestWindow = {
  location: URL;
  history: {
    replaceState: (_data: unknown, _unused: string, url: string) => void;
  };
  desktopBridge?: DesktopBridge;
};

function installTestBrowser(url: string) {
  const testWindow: TestWindow = {
    location: new URL(url),
    history: {
      replaceState: (_data, _unused, nextUrl) => {
        testWindow.location = new URL(nextUrl, testWindow.location.href);
      },
    },
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "T3 Code" });

  return testWindow;
}

describe("resolveInitialServerAuthGateState", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    const { __resetServerAuthBootstrapForTests } = await import("./authBootstrap");
    __resetServerAuthBootstrapForTests();
    vi.restoreAllMocks();
  });

  it("reuses an in-flight silent bootstrap attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        wsUrl: "ws://localhost:3773/ws",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./authBootstrap");

    await Promise.all([resolveInitialServerAuthGateState(), resolveInitialServerAuthGateState()]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost/api/auth/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost/api/auth/bootstrap");
  });

  it("uses https fetch urls when the primary environment uses wss", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com/ws");

    const { resolveInitialServerAuthGateState } = await import("./authBootstrap");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
    });
  });

  it("uses the current origin as an auth proxy base for local dev environments", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_WS_URL", "ws://127.0.0.1:3773/ws");
    installTestBrowser("http://localhost:5735/");

    const { resolveInitialServerAuthGateState } = await import("./authBootstrap");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:5735/api/auth/session", {
      credentials: "include",
    });
  });

  it("returns a requires-auth state instead of throwing when no bootstrap credential exists", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./authBootstrap");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
  });

  it("takes a pairing token from the location and strips it immediately", async () => {
    const testWindow = installTestBrowser("http://localhost/?token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./authBootstrap");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("allows manual token submission after the initial auth check requires pairing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost/");

    const { resolveInitialServerAuthGateState, submitServerAuthCredential } =
      await import("./authBootstrap");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
    await expect(submitServerAuthCredential("retry-token")).resolves.toBeUndefined();
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("revalidates the server session state after a previous authenticated result", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./authBootstrap");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
