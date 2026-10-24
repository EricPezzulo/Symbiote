import { describe, expect, it } from "vitest";
import { buildMatcher } from "./entities.js";
import type { AssetClass } from "./types.js";

const mk = (pairs: [string, AssetClass][], extra?: Record<string, string[]>) => buildMatcher(new Map(pairs), extra);

describe("entity matcher", () => {
  const m = mk([["AAPL", "stock"], ["TSLA", "stock"], ["BTC", "crypto"], ["ETH", "crypto"], ["ARM", "stock"], ["ALL", "stock"], ["V", "stock"], ["SOL", "crypto"], ["LINK", "crypto"], ["META", "stock"], ["TGT", "stock"]]);

  it("matches bare uppercase tickers on word boundaries", () => {
    expect(m.match("TSLA shares rise after deliveries")).toEqual(["TSLA"]);
    expect(m.match("Shares of AAPL, TSLA fall")).toEqual(["AAPL", "TSLA"]);
    expect(m.match("(AAPL) beats")).toEqual(["AAPL"]);
  });
  it("does not match inside other words or lowercase", () => {
    expect(m.match("TSLAQ short sellers")).toEqual([]);
    expect(m.match("xTSLA")).toEqual([]);
    expect(m.match("tsla trending")).toEqual([]);
    expect(m.match("AAPL.x token")).toEqual(["AAPL"]); // trailing dot is punctuation; documented behaviour
  });
  it("matches cashtags (case-insensitive) even for ambiguous tickers", () => {
    expect(m.match("Loading up on $ARM today")).toEqual(["ARM"]);
    expect(m.match("$all in")).toEqual(["ALL"]);
    expect(m.match("$V and $aapl")).toEqual(["AAPL", "V"]);
  });
  it("matches exchange-prefixed tickers", () => {
    expect(m.match("Arm Holdings (NASDAQ: ARM) reported")).toEqual(["ARM"]);
    expect(m.match("Allstate (NYSE:ALL) fell")).toEqual(["ALL"]);
  });
  it("FALSE POSITIVES: ambiguous tickers and short tickers need more than a bare word", () => {
    expect(m.match("ARM yourself with these tips")).toEqual([]);
    expect(m.match("We ALL know the score")).toEqual([]);
    expect(m.match("Plan B: V for victory")).toEqual([]);
    expect(m.match("Why you should LINK your accounts")).toEqual([]);
    expect(m.match("I think she was right to arm the rebels, ALL of them")).toEqual([]);
  });
  it("matches name aliases (case-sensitive for stocks, long forms for ambiguous names)", () => {
    expect(m.match("Apple unveils a new iPhone")).toEqual(["AAPL"]);
    expect(m.match("Arm Holdings raises guidance")).toEqual(["ARM"]);
    expect(m.match("Allstate raises premiums")).toEqual(["ALL"]);
    expect(m.match("Target Corp cuts outlook")).toEqual(["TGT"]);
    expect(m.match("Meta Platforms and Facebook")).toEqual(["META"]);
  });
  it("FALSE POSITIVES for names", () => {
    expect(m.match("an apple a day keeps the doctor away")).toEqual([]);
    expect(m.match("Pineapple prices rise")).toEqual([]);
    expect(m.match("Hit the target this quarter")).toEqual([]);
    expect(m.match("The meta game of poker")).toEqual([]);
    expect(m.match("Applebee's earnings")).toEqual([]);
  });
  it("crypto names are case-insensitive; tickers uppercase", () => {
    expect(m.match("bitcoin hits new high")).toEqual(["BTC"]);
    expect(m.match("Ethereum upgrade; BTC steady")).toEqual(["BTC", "ETH"]);
    expect(m.match("Solana outage")).toEqual(["SOL"]);
    expect(m.match("sol is the sun")).toEqual([]);
    expect(m.match("Chainlink adds feeds")).toEqual(["LINK"]);
  });
  it("ignores symbols outside the universe", () => {
    expect(m.match("MSFT and Microsoft rally")).toEqual([]);
  });
  it("skips bare/name matching in ALL-CAPS shouting headlines but keeps cashtags", () => {
    expect(m.match("TSLA AND AAPL SHARES SURGE ON HUGE NEWS TODAY")).toEqual([]);
    expect(m.match("TSLA AND $AAPL SHARES SURGE ON HUGE NEWS TODAY")).toEqual(["AAPL"]);
  });
  it("supports extra aliases and symbols with dots", () => {
    const m2 = mk([["BRK.B", "stock"], ["XYZ", "stock"]], { XYZ: ["Xyzzy Industries"] });
    expect(m2.match("BRK.B hits record")).toEqual(["BRK.B"]);
    expect(m2.match("Berkshire Hathaway buys")).toEqual(["BRK.B"]);
    expect(m2.match("Xyzzy Industries wins contract")).toEqual(["XYZ"]);
  });
  it("handles empty text", () => {
    expect(m.match("")).toEqual([]);
  });
});
