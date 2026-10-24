import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlpacaProvider } from "./alpaca.js";
import { snapshotsToTicks } from "./alpaca-rest.js";
import { silentLogger } from "../log.js";
import { startMockServer, waitFor, type MockServer } from "../../test/mock-server.js";
import type { Tick } from "../types.js";

let srv: MockServer;
let provider: AlpacaProvider | null = null;
beforeEach(async () => {
  srv = await startMockServer();
});
afterEach(async () => {
  await provider?.stop();
  provider = null;
  await srv.close();
});

const mk = (over: Record<string, unknown> = {}, fetchImpl?: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
  new AlpacaProvider(
    {
      wsUrl: srv.url,
      dataUrl: "http://data.invalid",
      keyId: "KID",
      secret: "SEC",
      maxSymbols: 30,
      overflowPollMs: 60_000,
      heartbeatMs: 5_000,
      backoff: { baseMs: 20, maxMs: 40 },
      fetch: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })),
      random: () => 0,
      ...over,
    },
    silentLogger,
  );

/** Standard Alpaca greeting/auth handshake. */
function alpacaServer(opts: { onSubscribe?: (m: any, ws: any) => void } = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
  srv.onConnection((ws) => {
    ws.send(JSON.stringify([{ T: "success", msg: "connected" }]));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.action === "auth") {
        ws.send(JSON.stringify([m.key === "KID" ? { T: "success", msg: "authenticated" } : { T: "error", code: 402, msg: "auth failed" }]));
      } else if (m.action === "subscribe") {
        if (opts.onSubscribe) return opts.onSubscribe(m, ws);
        ws.send(JSON.stringify([{ T: "subscription", trades: m.trades, quotes: m.quotes, bars: [] }]));
      }
    });
  });
}

describe("AlpacaProvider protocol", () => {
  it("authenticates, subscribes after auth, and emits trade ticks", async () => {
    alpacaServer();
    provider = mk();
    const ticks: Tick[] = [];
    provider.onTick((t) => ticks.push(t));
    provider.subscribe(["AAPL", "MSFT"]);
    provider.start();
    await waitFor(() => srv.received.some((m) => m.action === "subscribe"), 3000, "subscribe");
    expect(srv.received[0]).toEqual({ action: "auth", key: "KID", secret: "SEC" });
    const sub = srv.received.find((m) => m.action === "subscribe");
    expect(sub.trades.sort()).toEqual(["AAPL", "MSFT"]);
    expect(sub.quotes.sort()).toEqual(["AAPL", "MSFT"]);
    srv.clients()[0].send(JSON.stringify([{ T: "t", S: "AAPL", p: 190.5, s: 10, t: "2026-03-02T15:00:00Z" }]));
    await waitFor(() => ticks.length === 1);
    expect(ticks[0]).toMatchObject({ symbol: "AAPL", price: 190.5, assetType: "stock", source: "alpaca", ts: Date.parse("2026-03-02T15:00:00Z") });
    expect(provider.status()).toBe("open");
  });

  it("sends only diffs for later subscribe/unsubscribe", async () => {
    alpacaServer();
    provider = mk();
    provider.subscribe(["AAPL"]);
    provider.start();
    await waitFor(() => srv.received.some((m) => m.action === "subscribe"));
    provider.subscribe(["TSLA"]);
    provider.unsubscribe(["AAPL"]);
    await waitFor(() => srv.received.some((m) => m.action === "unsubscribe"));
    const subs = srv.received.filter((m) => m.action === "subscribe");
    expect(subs[1].trades).toEqual(["TSLA"]);
    expect(srv.received.find((m) => m.action === "unsubscribe").trades).toEqual(["AAPL"]);
  });

  it("ignores malformed frames and unknown messages, keeps working", async () => {
    alpacaServer();
    provider = mk();
    const ticks: Tick[] = [];
    provider.onTick((t) => ticks.push(t));
    provider.subscribe(["AAPL"]);
    provider.start();
    await waitFor(() => srv.received.some((m) => m.action === "subscribe"));
    const ws = srv.clients()[0];
    ws.send("not json {");
    ws.send(JSON.stringify([{ T: "t", S: "AAPL", p: "bad" }, { T: "t", p: 5 }, null, 42, { T: "zzz" }]));
    ws.send(JSON.stringify([{ T: "t", S: "AAPL", p: 10, t: "2026-03-02T15:00:01Z" }]));
    await waitFor(() => ticks.length === 1);
    expect(ticks[0].price).toBe(10);
  });

  it("uses quotes only until a trade price is known", async () => {
    alpacaServer();
    provider = mk();
    const ticks: Tick[] = [];
    provider.onTick((t) => ticks.push(t));
    provider.subscribe(["AAPL"]);
    provider.start();
    await waitFor(() => srv.received.some((m) => m.action === "subscribe"));
    const ws = srv.clients()[0];
    ws.send(JSON.stringify([{ T: "q", S: "AAPL", bp: 99, ap: 101, t: "2026-03-02T15:00:00Z" }]));
    await waitFor(() => ticks.length === 1);
    expect(ticks[0]).toMatchObject({ price: 100, source: "alpaca-quote" });
    ws.send(JSON.stringify([{ T: "t", S: "AAPL", p: 100.2, t: "2026-03-02T15:00:01Z" }]));
    ws.send(JSON.stringify([{ T: "q", S: "AAPL", bp: 1, ap: 3, t: "2026-03-02T15:00:02Z" }]));
    await waitFor(() => ticks.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks).toHaveLength(2);
  });

  it("reconnects with backoff after the server drops the connection and resubscribes", async () => {
    alpacaServer();
    provider = mk();
    provider.subscribe(["AAPL"]);
    provider.start();
    await waitFor(() => srv.received.filter((m) => m.action === "subscribe").length === 1);
    srv.clients()[0].terminate();
    await waitFor(() => srv.received.filter((m) => m.action === "subscribe").length === 2, 3000, "resubscribe");
    expect(srv.connections.length).toBe(2);
    expect(srv.received.filter((m) => m.action === "auth")).toHaveLength(2);
  });

  it("halts on auth failure (402) instead of retrying forever", async () => {
    alpacaServer();
    provider = mk({ keyId: "WRONG" });
    provider.subscribe(["AAPL"]);
    provider.start();
    await waitFor(() => provider!.status() === "failed");
    await new Promise((r) => setTimeout(r, 150));
    expect(srv.connections.length).toBe(1);
  });

  it("only streams maxSymbols and polls the overflow via REST snapshots", async () => {
    alpacaServer();
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ZZZ: { latestTrade: { p: 12.5, t: "2026-03-02T15:00:00Z" }, prevDailyBar: { t: "2026-02-27T05:00:00Z", o: 1, h: 2, l: 1, c: 11, v: 5 }, dailyBar: { c: 12.5, v: 99 } },
      }),
      url,
    }));
    provider = mk({ maxSymbols: 2 }, fetchMock);
    const ticks: Tick[] = [];
    provider.onTick((t) => ticks.push(t));
    provider.subscribe(["AAA", "BBB", "ZZZ"]);
    provider.start();
    await waitFor(() => srv.received.some((m) => m.action === "subscribe"));
    const sub = srv.received.find((m) => m.action === "subscribe");
    expect(sub.trades.sort()).toEqual(["AAA", "BBB"]);
    expect(provider.split().overflow).toEqual(["ZZZ"]);
    await waitFor(() => ticks.some((t) => t.symbol === "ZZZ"));
    const z = ticks.find((t) => t.symbol === "ZZZ")!;
    expect(z).toMatchObject({ price: 12.5, prevClose: 11 });
    expect(z.prevDay).toMatchObject({ day: "2026-02-27", close: 11 });
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("/v2/stocks/snapshots?symbols=");
    expect(calledUrl).toContain("feed=iex");
  });

  it("adapts to a 405 symbol-limit error by shrinking the stream set", async () => {
    let first = true;
    alpacaServer({
      onSubscribe: (m, ws) => {
        if (first) {
          first = false;
          ws.send(JSON.stringify([{ T: "subscription", trades: ["AAA", "BBB"], quotes: ["AAA", "BBB"], bars: [] }]));
          ws.send(JSON.stringify([{ T: "error", code: 405, msg: "symbol limit exceeded" }]));
        }
      },
    });
    provider = mk({ maxSymbols: 30 });
    provider.subscribe(["AAA", "BBB", "CCC"]);
    provider.start();
    await waitFor(() => provider!.split().overflow.length === 1, 3000, "overflow after 405");
    expect(provider.split().active).toEqual(["AAA", "BBB"]);
    expect(provider.split().overflow).toEqual(["CCC"]);
  });
});

describe("snapshotsToTicks", () => {
  it("handles wrapped and bare responses, and missing data", () => {
    const body = { AAPL: { latestTrade: { p: 10, t: "2026-03-02T15:00:00Z" }, prevDailyBar: { t: "2026-02-27T05:00:00Z", o: 9, h: 11, l: 8, c: 9.5, v: 1 } }, EMPTY: {}, BAD: null };
    expect(snapshotsToTicks(body)).toHaveLength(1);
    expect(snapshotsToTicks({ snapshots: body })[0].prevClose).toBe(9.5);
    expect(snapshotsToTicks(null)).toEqual([]);
  });
});
