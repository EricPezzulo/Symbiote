import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { groupByAccount, parseCsv, parseFidelityCsv, parseNumber } from "./fidelity";

const fixture = readFileSync(path.join(__dirname, "fixtures/positions.csv"), "utf8");

describe("parseNumber", () => {
  it.each([
    ["$1,905.00", 1905],
    ["-$250.00", -250],
    ["+$1.20", 1.2],
    ["(12.50)", -12.5],
    ["45.10%", 45.1],
    ["3.5", 3.5],
  ])("%s", (raw, n) => expect(parseNumber(raw)).toBe(n));
  it.each(["--", "", "n/a", "abc", "$"])("blank/invalid %j -> null", (raw) =>
    expect(parseNumber(raw)).toBeNull(),
  );
});

describe("parseCsv", () => {
  it("handles quotes, commas, escaped quotes and embedded newlines", () => {
    const rows = parseCsv('a,"b,c","say ""hi""","x\ny"\n1,2,3,4');
    expect(rows[0].fields).toEqual(["a", "b,c", 'say "hi"', "x\ny"]);
    expect(rows[1].fields).toEqual(["1", "2", "3", "4"]);
  });
});

describe("parseFidelityCsv", () => {
  const res = parseFidelityCsv(fixture);
  it("has no fatal errors despite BOM and leading blank line", () => {
    expect(res.errors).toEqual([]);
  });
  it("parses positions with $ and , formatting and quoted descriptions", () => {
    const aapl = res.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl).toMatchObject({
      accountNumber: "X12345678",
      accountName: "Individual",
      quantity: 10,
      lastPrice: 190.5,
      currentValue: 1905,
      costBasis: 1500,
      assetType: "stock",
    });
    expect(res.rows.find((r) => r.symbol === "VTI")!.description).toContain("TOTAL STK MKT ETF, USD");
    expect(res.rows.find((r) => r.symbol === "VTI")!.quantity).toBe(3.5);
  });
  it("treats -- and n/a as null cost basis", () => {
    const msft = res.rows.find((r) => r.symbol === "MSFT")!;
    expect(msft.costBasis).toBeNull();
    expect(msft.quantity).toBe(5);
  });
  it("normalises money market sweep rows (SPAXX**) and fills quantity from value", () => {
    const spaxx = res.rows.find((r) => r.symbol === "SPAXX")!;
    expect(spaxx).toMatchObject({ assetType: "cash", isMoneyMarket: true, quantity: 1234.56, costBasis: 1234.56, lastPrice: 1 });
    const fz = res.rows.find((r) => r.symbol === "FZFXX")!;
    expect(fz).toMatchObject({ quantity: 500, assetType: "cash" });
  });
  it("skips pending activity and disclaimer lines", () => {
    expect(res.rows.map((r) => r.symbol)).not.toContain("PENDING ACTIVITY");
    const reasons = res.skipped.map((s) => s.reason);
    expect(reasons).toContain("Pending activity");
    expect(reasons.filter((r) => r.startsWith("Footer"))).toHaveLength(2);
    expect(res.rows).toHaveLength(5);
  });
  it("groups by account", () => {
    const g = groupByAccount(res.rows);
    expect(g.map((a) => [a.number, a.name, a.rows.length])).toEqual([
      ["X12345678", "Individual", 3],
      ["Z98765432", "Roth IRA", 2],
    ]);
  });
  it("merges duplicate symbols within an account", () => {
    const csv =
      "Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total\n" +
      'A123,Brokerage,TSLA,TESLA,1,$200,$200,$100\nA123,Brokerage,TSLA,TESLA,2,$200,$400,$300\n';
    const g = groupByAccount(parseFidelityCsv(csv).rows);
    expect(g[0].rows).toHaveLength(1);
    expect(g[0].rows[0]).toMatchObject({ quantity: 3, costBasis: 400, currentValue: 600 });
  });
  it("reports a clear error for non-Fidelity files", () => {
    expect(parseFidelityCsv("foo,bar\n1,2").errors[0]).toMatch(/header row/);
    expect(parseFidelityCsv("").errors).toHaveLength(1);
  });
});
