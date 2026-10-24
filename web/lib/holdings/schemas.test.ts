import { describe, expect, it } from "vitest";
import { accountSchema, holdingSchema } from "./schemas";

const base = { account_id: "6f1c1d0e-8d7a-4c1e-9a53-2f5d3a0c7b11", symbol: " aapl ", asset_type: "stock", quantity: "1,000.5", cost_basis: "$1,500" };

describe("holdingSchema", () => {
  it("normalises symbol, quantity and cost basis", () => {
    expect(holdingSchema.parse(base)).toMatchObject({ symbol: "AAPL", quantity: 1000.5, cost_basis: 1500 });
  });
  it("blank cost basis -> null", () => {
    expect(holdingSchema.parse({ ...base, cost_basis: "" }).cost_basis).toBeNull();
  });
  it.each([
    [{ quantity: "0" }], [{ quantity: "abc" }], [{ quantity: "-1" }], [{ symbol: "" }], [{ symbol: "A B" }],
    [{ asset_type: "bond" }], [{ cost_basis: "-5" }], [{ account_id: "nope" }],
  ])("rejects %j", (o) => expect(holdingSchema.safeParse({ ...base, ...o }).success).toBe(false));
});

describe("accountSchema", () => {
  it("accepts valid and rejects bad", () => {
    expect(accountSchema.parse({ name: " Roth ", type: "brokerage", institution: "" })).toEqual({ name: "Roth", type: "brokerage", institution: null });
    expect(accountSchema.safeParse({ name: "", type: "brokerage", institution: "" }).success).toBe(false);
    expect(accountSchema.safeParse({ name: "x", type: "bank", institution: "" }).success).toBe(false);
  });
});
