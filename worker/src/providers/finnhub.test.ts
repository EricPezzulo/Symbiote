import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FinnhubProvider } from "./finnhub.js";
import { silentLogger } from "../log.js";
import { startMockServer, waitFor, type MockServer } from "../../test/mock-server.js";
import type { Tick } from "../types.js";

let srv: MockServer;
let p: FinnhubProvider | null = null;
beforeEach(async () => (srv = await startMockServer()));
afterEach(async () => {
  await p?.stop();
  await srv.close();
});

describe("FinnhubProvider", () => {
  it("passes the token in the URL, subscribes per symbol, and collapses multi-trade frames", async () => {
    const quotes: string[] = [];
    p = new FinnhubProvider(
      {
        apiKey: "TOK",
        wsUrl: srv.url,
        heartbeatMs: 5000,
        backoff: { baseMs: 20, maxMs: 40 },
        quoteGapMs: 5,
        fetch: async (url) => {
          quotes.push(url);
          return { ok: true, status: 200, json: async () => ({ c: 101, pc: 100, t: 1_700_000_000 }) };
        },
      },
      silentLogger,
    );
    const ticks: Tick[] = [];
    p.onTick((t) => ticks.push(t));
    p.subscribe(["AAPL"]);
    p.start();
    await waitFor(() => srv.received.length === 1);
    expect(srv.connections[0]).toBe("/?token=TOK");
    expect(srv.received[0]).toEqual({ type: "subscribe", symbol: "AAPL" });
    await waitFor(() => quotes.length === 1);
    await waitFor(() => ticks.length === 1); // quote seed
    srv.clients()[0].send("garbage");
    srv.clients()[0].send(JSON.stringify({ type: "ping" }));
    srv.clients()[0].send(JSON.stringify({ type: "trade", data: [{ s: "AAPL", p: 102, t: 1_700_000_001_000, v: 1 }, { s: "AAPL", p: 103, t: 1_700_000_002_000, v: 2 }] }));
    await waitFor(() => ticks.length === 2);
    expect(ticks[1]).toMatchObject({ symbol: "AAPL", price: 103, prevClose: 100, source: "finnhub" });
    p.subscribe(["MSFT"]);
    p.unsubscribe(["AAPL"]);
    await waitFor(() => srv.received.length === 3);
    expect(srv.received[2]).toEqual({ type: "unsubscribe", symbol: "AAPL" });
  });
});
