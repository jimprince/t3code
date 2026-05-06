import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  issueRemoteWebSocketToken,
  resolveRemoteWebSocketConnectionUrl,
} from "./api";
import { resolveRemotePairingTarget } from "./target";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://app.example.com",
      },
    },
  });
  vi.restoreAllMocks();
});

describe("remote environment api", () => {
  it("derives backend urls and token from a pairing url", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("accepts pairing urls that still use a query token", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair?token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("preserves http and port from a LAN pairing url", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "http://192.168.50.131:3773/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "http://192.168.50.131:3773/",
      wsBaseUrl: "ws://192.168.50.131:3773/",
    });
  });

  it("derives backend urls from a host and pairing code", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("preserves host ports when normalizing a bare host input", () => {
    expect(
      resolveRemotePairingTarget({
        host: "myserver.com:3000",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://myserver.com:3000/",
      wsBaseUrl: "wss://myserver.com:3000/",
    });
  });

  it("defaults bare LAN hosts to the local T3 backend endpoint", () => {
    expect(
      resolveRemotePairingTarget({
        host: "192.168.50.131",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "http://192.168.50.131:3773/",
      wsBaseUrl: "ws://192.168.50.131:3773/",
    });
  });

  it("defaults bare Tailscale hosts to the local T3 backend endpoint", () => {
    expect(
      resolveRemotePairingTarget({
        host: "100.64.0.4",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "http://100.64.0.4:3773/",
      wsBaseUrl: "ws://100.64.0.4:3773/",
    });
  });

  it("repairs scheme-only LAN host entries that would otherwise try HTTPS port 443", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://192.168.50.131",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "http://192.168.50.131:3773/",
      wsBaseUrl: "ws://192.168.50.131:3773/",
    });
  });

  it("bootstraps bearer auth against a remote backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          role: "client",
          sessionMethod: "bearer-session-token",
          expiresAt: "2026-05-01T12:00:00.000Z",
          sessionToken: "bearer-token",
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      bootstrapRemoteBearerSession({
        httpBaseUrl: "https://remote.example.com/",
        credential: "pairing-token",
      }),
    ).resolves.toMatchObject({
      sessionMethod: "bearer-session-token",
      sessionToken: "bearer-token",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/bootstrap/bearer", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        credential: "pairing-token",
      }),
    });
  });

  it("loads remote session state and websocket tokens over bearer auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            environmentId: "environment-remote",
            label: "Remote environment",
            platform: {
              os: "linux",
              arch: "x64",
            },
            serverVersion: "0.0.0-test",
            capabilities: {
              repositoryIdentity: true,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["browser-session-cookie", "bearer-session-token"],
              sessionCookieName: "t3_session",
            },
            role: "client",
            sessionMethod: "bearer-session-token",
            expiresAt: "2026-05-01T12:00:00.000Z",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "ws-token",
            expiresAt: "2026-05-01T12:05:00.000Z",
          }),
          { status: 200 },
        ),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com/",
      }),
    ).resolves.toMatchObject({
      environmentId: "environment-remote",
      label: "Remote environment",
    });

    await expect(
      fetchRemoteSessionState({
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "bearer-token",
      }),
    ).resolves.toMatchObject({
      authenticated: true,
      role: "client",
    });

    await expect(
      issueRemoteWebSocketToken({
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "bearer-token",
      }),
    ).resolves.toMatchObject({
      token: "ws-token",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://remote.example.com/.well-known/t3/environment",
      {
        method: "GET",
        headers: {},
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://remote.example.com/api/auth/session", {
      method: "GET",
      headers: {
        authorization: "Bearer bearer-token",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://remote.example.com/api/auth/ws-token", {
      method: "POST",
      headers: {
        authorization: "Bearer bearer-token",
      },
    });
  });

  it("mints a websocket url with a short-lived ws token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "ws-token",
          expiresAt: "2026-05-01T12:05:00.000Z",
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: "wss://remote.example.com/",
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "bearer-token",
      }),
    ).resolves.toBe("wss://remote.example.com/ws?wsToken=ws-token");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
