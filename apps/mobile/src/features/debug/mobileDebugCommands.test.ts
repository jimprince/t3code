import { describe, expect, it } from "vitest";

import { parseMobileDebugCommand } from "./mobileDebugCommands";

describe("parseMobileDebugCommand", () => {
  it("parses fork pair commands", () => {
    expect(
      parseMobileDebugCommand(
        "t3code-brad-dev://debug/pair?pairingUrl=http%3A%2F%2F100.64.0.4%3A3773%2Fpair%23token%3Dsecret&replace=1",
      ),
    ).toEqual({
      type: "pair",
      pairingUrl: "http://100.64.0.4:3773/pair#token=secret",
      replaceExisting: true,
    });
  });

  it("parses dump and clear commands", () => {
    expect(parseMobileDebugCommand("t3code-brad-dev://debug/dump")).toEqual({ type: "dump" });
    expect(parseMobileDebugCommand("t3code-brad-dev://debug/clear-connections")).toEqual({
      type: "clear-connections",
    });
  });

  it("parses disconnect commands", () => {
    expect(parseMobileDebugCommand("t3code-brad-dev://debug/disconnect?all=1")).toEqual({
      type: "disconnect",
      all: true,
      environmentId: null,
    });
    expect(
      parseMobileDebugCommand("t3code-brad-dev://debug/disconnect?environmentId=env-1"),
    ).toEqual({
      type: "disconnect",
      all: false,
      environmentId: "env-1",
    });
  });

  it("ignores non-debug URLs", () => {
    expect(parseMobileDebugCommand("t3code-brad-dev://threads/example")).toBeNull();
  });
});
