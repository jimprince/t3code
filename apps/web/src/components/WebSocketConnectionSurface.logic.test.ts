import { describe, expect, it } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  buildExhaustedToastDescription,
  buildOfflineToastDescription,
  buildReconnectToastDescription,
  shouldAutoReconnect,
  shouldRestartStalledReconnect,
} from "./WebSocketConnectionSurface";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectionLabel: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("forces reconnect on online when the app was offline", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          online: false,
          phase: "disconnected",
        }),
        "online",
      ),
    ).toBe(true);
  });

  it("forces reconnect on focus only for previously connected disconnected states", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(true);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it("forces reconnect on focus for exhausted reconnect loops", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        "focus",
      ),
    ).toBe(true);
  });

  it("restarts a stalled reconnect window after the scheduled retry time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);

    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "attempting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(false);
  });

  it("describes websocket close details and retry timing without leaking credentials or query tokens", () => {
    expect(
      buildReconnectToastDescription(
        makeStatus({
          closeCode: 1012,
          closeReason: "service restart",
          connectionLabel: "Remote Mac",
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:05.000Z",
          phase: "disconnected",
          reconnectAttemptCount: 2,
          reconnectPhase: "waiting",
          socketUrl: "wss://user:pass@remote.example.test/ws?ticket=secret-token#fragment",
        }),
        Date.parse("2026-04-03T20:00:01.000Z"),
      ),
    ).toBe(
      "Close 1012: service restart. Endpoint: wss://remote.example.test/ws. Retrying in 4s. Attempt 2/8.",
    );
  });

  it("includes last error details when reconnect retries are exhausted", () => {
    expect(
      buildExhaustedToastDescription(
        makeStatus({
          connectionLabel: "Remote Mac",
          hasConnected: true,
          lastError: "Unable to connect to the T3 server WebSocket.",
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
          socketUrl: "wss://remote.example.test/ws",
        }),
      ),
    ).toBe(
      "Last error: Unable to connect to the T3 server WebSocket. Endpoint: wss://remote.example.test/ws. Retries exhausted. Use Retry to start a fresh connection.",
    );
  });

  it("explains that offline disconnects wait for browser network recovery", () => {
    expect(
      buildOfflineToastDescription(
        makeStatus({
          closeCode: 1006,
          connectionLabel: "Remote Mac",
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          hasConnected: true,
          online: false,
          phase: "disconnected",
        }),
      ),
    ).toBe(
      "Remote Mac disconnected while this browser is offline. Close code 1006. Reconnect will resume when the network is back.",
    );
  });
});
