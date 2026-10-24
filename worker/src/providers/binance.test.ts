import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BinanceProvider } from "./binance.js";
import { silentLogger } from "../log.js";
import { startMockServer, waitFor, type MockServer } from "../../test/mock-server.js";
import type { Tick } from "../types.js";

let srv: MockServer;
let p: BinanceProvider | null = null;
beforeEach(async () => {
  srv = await startMockServer();
});
afterEach(async () => {
  await p?.stop();
  p = null;
  await srv.close();
});

const mk = (over: Record<string, unknown> = {}) =>
  new BinanceProvider({ wsUrl: srv.url, heartbeatMs: 5000, backoff: { baseMs: 20, maxMs: 40 }, random: () => 0, controlGapMs: 5, ...over }, silentLogger);
const mini = (s: string, c: string, o: string) => ({ stream: `${s.toLowerCase()}@miniTicker`, data: { e: "24hrMiniTicker", E: 1_700_000_000_000, s, c, o, h: c, l: o, v: "1", q: "1000" } });

describe("BinanceProvider", () => {
  it("connects with a combined-stream URL and maps pairs back to app symbols", async () => {
    p = mk();
    const ticks: Tick[] = [];
    p.onTick((t) => ticks.push(t));
    p.subscribe(["BTC", "ETH"]);
    p.start();
    await waitFor(() => srv.connections.length === 1);
    expect(srv.connections[0]).toBe("/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker");
    await waitFor(() => srv.clients().length === 1);
    srv.clients()[0].send(JSON.stringify(mini("BTCUSDT", "50000.00", "40000.00")));
    await waitFor(() => ticks.length === 1);
    expect(ticks[0]).toMatchObject({ symbol: "BTC", assetType: "crypto", price: 50000, prevClose: 40000, volume: 1000, source: "binance", ts: 1_700_000_000_000 });
    expect(ticks[0].changePct).toBeCloseTo(25);
  });

  it("sends SUBSCRIBE/UNSUBSCRIBE diffs while connected", async () => {
    p = mk();
    const ticks: Tick[] = [];
    p.onTick((t) => ticks.push(t));
    p.subscribe(["BTC"]);
    p.start();
    await waitFor(() => srv.clients().length === 1);
    await new Promise((r) => setTimeout(r, 30));
    p.subscribe(["SOL"]);
    p.unsubscribe(["BTC"]);
    await waitFor(() => srv.received.length === 2);
    expect(srv.received[0]).toMatchObject({ method: "SUBSCRIBE", params: ["solusdt@miniTicker"] });
    expect(srv.received[1]).toMatchObject({ method: "UNSUBSCRIBE", params: ["btcusdt@miniTicker"] });
    srv.clients()[0].send(JSON.stringify(mini("SOLUSDT", "100", "90")));
    await waitFor(() => ticks.length === 1);
    expect(ticks[0].symbol).toBe("SOL");
  });

  it("ignores malformed frames, control replies and untracked pairs", async () => {
    p = mk();
    const ticks: Tick[] = [];
    p.onTick((t) => ticks.push(t));
    p.subscribe(["BTC"]);
    p.start();
    await waitFor(() => srv.clients().length === 1);
    const ws = srv.clients()[0];
    ws.send("}{");
    ws.send(JSON.stringify({ result: null, id: 1 }));
    ws.send(JSON.stringify({ error: { code: 2, msg: "Invalid request" }, id: 2 }));
    ws.send(JSON.stringify(mini("DOGEUSDT", "1", "1")));
    ws.send(JSON.stringify(mini("BTCUSDT", "abc", "1")));
    ws.send(JSON.stringify(mini("BTCUSDT", "60000", "59000")));
    await waitFor(() => ticks.length === 1);
    expect(ticks[0].price).toBe(60000);
  });

  it("reconnects using the current desired set in the URL", async () => {
    p = mk();
    p.subscribe(["BTC"]);
    p.start();
    await waitFor(() => srv.clients().length === 1);
    await new Promise((r) => setTimeout(r, 30));
    p.subscribe(["ETH"]);
    srv.clients()[0].terminate();
    await waitFor(() => srv.connections.length === 2, 3000, "reconnect");
    expect(srv.connections[1]).toBe("/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker");
  });

  it("falls back to SUBSCRIBE batches when there are too many streams for the URL", async () => {
    p = mk({ maxUrlStreams: 2 });
    p.subscribe(["A1", "A2", "A3"]);
    p.start();
    await waitFor(() => srv.received.length >= 1);
    expect(srv.connections[0]).toBe("/stream");
    expect(srv.received[0].method).toBe("SUBSCRIBE");
    expect(srv.received[0].params).toHaveLength(3);
  });
});
