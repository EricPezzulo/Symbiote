// Parser for Fidelity "Portfolio Positions" CSV exports. Pure (no I/O) so it can
// run in the browser for previews and on the server for the authoritative import.

export type FidelityRow = {
  accountNumber: string;
  accountName: string;
  symbol: string; // normalised: trailing "**" removed
  description: string;
  quantity: number;
  lastPrice: number | null;
  currentValue: number | null;
  costBasis: number | null; // total cost basis
  assetType: "stock" | "cash";
  isMoneyMarket: boolean;
};

export type FidelitySkipped = { line: number; reason: string; raw: string };

export type FidelityParseResult = {
  rows: FidelityRow[];
  skipped: FidelitySkipped[];
  errors: string[]; // fatal problems (e.g. no header)
};

/** RFC 4180-ish CSV tokenizer: quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(text: string): { fields: string[]; line: number }[] {
  const out: { fields: string[]; line: number }[] = [];
  let field = "";
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const src = text.replace(/^﻿/, "");

  const endRow = () => {
    fields.push(field);
    field = "";
    out.push({ fields, line: rowLine });
    fields = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      fields.push(field);
      field = "";
    } else if (c === "\r") {
      // swallow; \n handles the row end
    } else if (c === "\n") {
      endRow();
      line++;
      rowLine = line;
    } else field += c;
  }
  if (field !== "" || fields.length > 0) endRow();
  return out;
}

const BLANK = new Set(["", "--", "n/a", "N/A", "-"]);

/** "$1,234.56", "-$5.00", "(12.5)", "+3.1%", "--" -> number | null. */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (BLANK.has(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,%\s+]/g, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

function norm(h: string) {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

const ACCOUNT_NUMBER = /^[A-Za-z0-9-]{3,}$/;

export function parseFidelityCsv(text: string): FidelityParseResult {
  const records = parseCsv(text);
  const result: FidelityParseResult = { rows: [], skipped: [], errors: [] };

  const headerIdx = records.findIndex((r) => {
    const h = r.fields.map(norm);
    return h.includes("symbol") && h.includes("quantity");
  });
  if (headerIdx === -1) {
    result.errors.push(
      'Could not find the header row (expected columns "Symbol" and "Quantity"). Is this a Fidelity Portfolio Positions export?',
    );
    return result;
  }
  const header = records[headerIdx].fields.map(norm);
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const cAcctNum = col("account number", "account");
  const cAcctName = col("account name");
  const cSymbol = col("symbol");
  const cDesc = col("description");
  const cQty = col("quantity");
  const cPrice = col("last price");
  const cValue = col("current value");
  const cCost = col("cost basis total", "cost basis");
  if (cAcctNum === -1 || cSymbol === -1 || cQty === -1) {
    result.errors.push("Missing required columns: Account Number, Symbol, Quantity.");
    return result;
  }
  const get = (f: string[], i: number) => (i === -1 ? "" : (f[i] ?? "").trim());

  for (const rec of records.slice(headerIdx + 1)) {
    const f = rec.fields;
    const raw = f.join(",").slice(0, 120);
    if (f.every((x) => x.trim() === "")) continue; // blank separator line

    const acct = get(f, cAcctNum);
    // Trailing disclaimer / footer lines: one long free-text cell in column 0.
    if (!ACCOUNT_NUMBER.test(acct) && f.slice(1).every((x) => x.trim() === "")) {
      result.skipped.push({ line: rec.line, reason: "Footer/disclaimer text", raw });
      continue;
    }
    if (!ACCOUNT_NUMBER.test(acct)) {
      result.skipped.push({ line: rec.line, reason: "No valid account number", raw });
      continue;
    }

    let symbol = get(f, cSymbol);
    if (/^pending activity$/i.test(symbol) || /^pending activity$/i.test(acct)) {
      result.skipped.push({ line: rec.line, reason: "Pending activity", raw });
      continue;
    }
    if (!symbol) {
      result.skipped.push({ line: rec.line, reason: "Missing symbol", raw });
      continue;
    }

    const isMoneyMarket = symbol.endsWith("**");
    symbol = symbol.replace(/\*+$/, "").toUpperCase();
    if (!/^[A-Z0-9.\-_/ ]{1,24}$/.test(symbol)) {
      result.skipped.push({ line: rec.line, reason: `Unrecognised symbol "${symbol.slice(0, 24)}"`, raw });
      continue;
    }

    const currentValue = parseNumber(get(f, cValue));
    const lastPrice = parseNumber(get(f, cPrice));
    let costBasis = parseNumber(get(f, cCost));
    let quantity = parseNumber(get(f, cQty));

    if (isMoneyMarket) {
      // Sweep funds often show "--" for quantity: $1 per unit, so value == quantity.
      if (quantity === null) quantity = currentValue;
      if (costBasis === null) costBasis = currentValue;
    }
    if (quantity === null) {
      result.skipped.push({ line: rec.line, reason: "Quantity missing or unparseable", raw });
      continue;
    }

    result.rows.push({
      accountNumber: acct,
      accountName: get(f, cAcctName) || acct,
      symbol,
      description: get(f, cDesc),
      quantity,
      lastPrice: isMoneyMarket && lastPrice === null ? 1 : lastPrice,
      currentValue,
      costBasis,
      assetType: isMoneyMarket ? "cash" : "stock",
      isMoneyMarket,
    });
  }

  if (result.rows.length === 0 && result.errors.length === 0) {
    result.errors.push("No positions found in file.");
  }
  return result;
}

/** Group parsed rows by account number, merging duplicate symbols (e.g. multiple lots). */
export function groupByAccount(rows: FidelityRow[]) {
  const accounts = new Map<string, { number: string; name: string; rows: FidelityRow[] }>();
  for (const r of rows) {
    let a = accounts.get(r.accountNumber);
    if (!a) accounts.set(r.accountNumber, (a = { number: r.accountNumber, name: r.accountName, rows: [] }));
    const existing = a.rows.find((x) => x.symbol === r.symbol);
    if (existing) {
      existing.quantity += r.quantity;
      existing.costBasis =
        existing.costBasis === null && r.costBasis === null ? null : (existing.costBasis ?? 0) + (r.costBasis ?? 0);
      existing.currentValue =
        existing.currentValue === null && r.currentValue === null
          ? null
          : (existing.currentValue ?? 0) + (r.currentValue ?? 0);
    } else a.rows.push({ ...r });
  }
  return [...accounts.values()];
}
