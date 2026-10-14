import { assert, expect, it } from "@effect/vitest";

import {
  buildPairingUrl,
  formatHeadlessServeOutput,
  renderTerminalQrCode,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats interactive headless output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput(
    {
      connectionString: "http://192.168.1.42:3773",
      token: "PAIRCODE",
      pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
    },
    true,
  );

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

it("defaults to readiness and address output without raw, encoded, or QR credentials", () => {
  const token = "TEST credential+/=?&";
  const pairingUrl = buildPairingUrl("http://192.168.1.42:3773", token);
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token,
    pairingUrl,
  });

  expect(output).not.toContain(token);
  expect(output).not.toContain(encodeURIComponent(token));
  expect(output).not.toContain(new URLSearchParams({ token }).toString());
  expect(output).not.toContain(pairingUrl);
  expect(output).not.toContain(renderTerminalQrCode(pairingUrl));
  expect(output).not.toMatch(/[█▀▄]/);
  expect(output).toContain("T3 Code server is ready.");
  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Pairing is available. Run t3 pair on this server");
});
