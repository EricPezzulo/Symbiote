import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { backoffDelay, ManagedSocket } from "./managed-socket.js";
import { silentLogger } from "../log.js";
import { startMockServer, waitFor, type MockServer } from "../../test/mock-server.js";

describe("backoffDelay", () => {
  it("grows exponentially with jitter and caps", () => {
    const o = { baseMs: 1000, maxMs: 8000 };
    expect(backoffDelay(0, o, () => 0)).toBe(500);
    expect(backoffDelay(0, o, () => 1)).toBe(1000);
    expect(backoffDelay(2, o, () => 0)).toBe(2000);
    expect(backoffDelay(10, o, () => 0)).toBe(4000);
    expect(backoffDelay(10, o, () => 0.999)).toBeLessThanOrEqual(8000);
    expect(backoffDelay(100, o, () => 1)).toBe(8000);
  });
});

describe("ManagedSocket", () => {
  let srv: MockServer;
  beforeEach(async () => (srv = await startMockServer()));
  afterEach(async () => srv.close());

  it("terminates and reconnects a connection that goes silent (stale detection)", async () => {
    // A server that never answers pings (autoPong disabled) and sends nothing.
    await srv.close();
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: false } as never);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    let connections = 0;
    wss.on("connection", () => connections++);
    let opens = 0;
    const s = new ManagedSocket({
      name: "t",
      url: () => `ws://127.0.0.1:${port}`,
      log: silentLogger,
      backoff: { baseMs: 10, maxMs: 20 },
      heartbeatMs: 20,
      random: () => 0,
      onOpen: () => opens++,
      onMessage: () => {},
    });
    s.start();
    await waitFor(() => connections >= 2, 3000, "stale reconnect");
    expect(opens).toBeGreaterThanOrEqual(2);
    await s.stop(50);
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("keeps a healthy connection alive when the peer answers pings", async () => {
    let opens = 0;
    const s = new ManagedSocket({
      name: "t",
      url: () => srv.url,
      log: silentLogger,
      backoff: { baseMs: 10, maxMs: 20 },
      heartbeatMs: 20,
      onOpen: () => opens++,
      onMessage: () => {},
    });
    s.start();
    await waitFor(() => s.isOpen());
    await new Promise((r) => setTimeout(r, 200));
    expect(opens).toBe(1);
    await s.stop(50);
  });
});
