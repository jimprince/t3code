import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Socket from "effect/socket/Socket";
import { openRpcConnection } from "../src/openRpc.js";

const environment = {
  httpBaseUrl: "http://test",
  wsBaseUrl: "ws://test",
  bearerToken: "synthetic",
};
const timeout = () =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("pre-open") }),
  });
afterEach(() => vi.useRealTimers());

it("uses four fresh clients and tickets, closes each failure and never sends a mutation", async () => {
  const clients: Array<{
    awaitOpen: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  }> = [];
  const resolveUrl = vi.fn(async () => `ws://test?ticket=${clients.length}`);
  const createClient = vi.fn(() => {
    const client = {
      awaitOpen: vi.fn().mockRejectedValue(timeout()),
      dispose: vi.fn().mockResolvedValue(undefined),
      request: vi.fn(),
    };
    clients.push(client);
    return client;
  });
  const delay = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => {});
  await expect(
    openRpcConnection(environment, { resolveUrl, createClient, random: () => 0.5, delay }),
  ).rejects.toMatchObject({ reason: { _tag: "SocketOpenError" } });
  expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1000, 2000, 4000]);
  const signals = delay.mock.calls.map(([, signal]) => signal);
  expect(new Set(signals).size).toBe(1);
  expect(signals[0]?.aborted).toBe(false);
  expect(resolveUrl).toHaveBeenCalledTimes(4);
  expect(createClient.mock.calls.map(([url]) => url)).toEqual(
    [0, 1, 2, 3].map((id) => `ws://test?ticket=${id}`),
  );
  for (const client of clients) {
    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(client.request).not.toHaveBeenCalled();
  }
});

it("returns the first open client, leaving its mutation failure to the caller without replay", async () => {
  const mutation = vi.fn().mockRejectedValue(timeout()); // same tag can mean an ambiguous heartbeat failure
  const failed = {
    awaitOpen: vi.fn().mockRejectedValue(timeout()),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const opened = {
    awaitOpen: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    request: mutation,
  };
  const createClient = vi.fn().mockReturnValueOnce(failed).mockReturnValue(opened);
  const pending = openRpcConnection(environment, {
    resolveUrl: async () => "ws://test",
    createClient,
    random: () => 0.5,
    delay: async () => {},
  });
  expect(await pending).toBe(opened);
  await expect(opened.request("dispatchCommand", {})).rejects.toBeInstanceOf(Socket.SocketError);
  expect(createClient).toHaveBeenCalledTimes(2);
  expect(failed.dispose).toHaveBeenCalledTimes(1);
  expect(opened.dispose).not.toHaveBeenCalled();
  expect(mutation).toHaveBeenCalledTimes(1);
});

it("does not retry authentication failures", async () => {
  const resolveUrl = vi.fn().mockRejectedValue(new Error("Unauthorized (401)"));
  const createClient = vi.fn();
  await expect(openRpcConnection(environment, { resolveUrl, createClient })).rejects.toThrow(
    "Unauthorized",
  );
  expect(resolveUrl).toHaveBeenCalledTimes(1);
  expect(createClient).not.toHaveBeenCalled();
});

it("enforces the 60 second deadline and closes a stalled opening client", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    setTimeout(() => controller.abort(new Error("overall open deadline")), ms);
    return controller.signal;
  });
  const client = {
    awaitOpen: vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    ),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const createClient = vi.fn(() => client);
  try {
    const pending = openRpcConnection(environment, {
      resolveUrl: async () => "ws://test",
      createClient,
    });
    const rejected = expect(pending).rejects.toThrow("overall open deadline");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(timeoutSignal).toHaveBeenCalledWith(60_000);
    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
  } finally {
    timeoutSignal.mockRestore();
  }
});
