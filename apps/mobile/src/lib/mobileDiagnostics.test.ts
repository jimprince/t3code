import { describe, expect, it } from "vitest";

import {
  clearMobileDiagnostics,
  getMobileDiagnosticTail,
  recordMobileDiagnostic,
  redactMobileDiagnosticData,
} from "./mobileDiagnostics";

describe("mobileDiagnostics", () => {
  it("redacts tokens and URL credentials from diagnostic payloads", () => {
    expect(
      redactMobileDiagnosticData({
        bearerToken: "secret-token",
        pairingUrl: "http://user:pass@example.com/pair?x=1#token=secret",
        nested: { wsToken: "socket-secret" },
      }),
    ).toEqual({
      bearerToken: "[redacted-present]",
      pairingUrl: "http://example.com/pair",
      nested: { wsToken: "[redacted-present]" },
    });
  });

  it("keeps a bounded diagnostic tail", () => {
    clearMobileDiagnostics();
    for (let index = 0; index < 305; index += 1) {
      recordMobileDiagnostic({
        level: "debug",
        tag: `event.${index}`,
      });
    }

    const tail = getMobileDiagnosticTail();
    expect(tail).toHaveLength(300);
    expect(tail[0]?.tag).toBe("event.5");
    expect(tail.at(-1)?.tag).toBe("event.304");
  });
});
