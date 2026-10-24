import type { AssetClass } from "./types.js";

/**
 * Symbol <-> name aliases. Names are matched on word boundaries; stock names are case-SENSITIVE
 * (so "apple pie" does not hit AAPL), crypto names are case-insensitive. Ambiguous one-word company
 * names are listed only in their unambiguous long form ("Target Corp", "Allstate").
 */
export const DEFAULT_ALIASES: Record<string, string[]> = {
  BTC: ["Bitcoin"],
  ETH: ["Ethereum"],
  SOL: ["Solana"],
  XRP: ["Ripple"],
  ADA: ["Cardano"],
  DOGE: ["Dogecoin"],
  AVAX: ["Avalanche"],
  DOT: ["Polkadot"],
  LINK: ["Chainlink"],
  LTC: ["Litecoin"],
  BCH: ["Bitcoin Cash"],
  BNB: ["Binance Coin"],
  UNI: ["Uniswap"],
  ATOM: ["Cosmos Hub"],
  AAPL: ["Apple Inc", "Apple"],
  MSFT: ["Microsoft"],
  GOOGL: ["Alphabet", "Google"],
  GOOG: ["Alphabet", "Google"],
  AMZN: ["Amazon"],
  META: ["Meta Platforms", "Facebook"],
  NVDA: ["Nvidia", "NVIDIA"],
  TSLA: ["Tesla"],
  AMD: ["Advanced Micro Devices"],
  INTC: ["Intel"],
  NFLX: ["Netflix"],
  ARM: ["Arm Holdings"],
  ALL: ["Allstate"],
  TGT: ["Target Corp", "Target Corporation"],
  V: ["Visa Inc"],
  F: ["Ford Motor"],
  JPM: ["JPMorgan", "JPMorgan Chase"],
  BAC: ["Bank of America"],
  WMT: ["Walmart"],
  COST: ["Costco"],
  DIS: ["Walt Disney", "Disney"],
  KO: ["Coca-Cola"],
  PEP: ["PepsiCo"],
  BA: ["Boeing"],
  XOM: ["Exxon Mobil", "ExxonMobil"],
  CVX: ["Chevron"],
  PFE: ["Pfizer"],
  JNJ: ["Johnson & Johnson"],
  UNH: ["UnitedHealth"],
  COIN: ["Coinbase"],
  MSTR: ["MicroStrategy", "Strategy Inc"],
  PLTR: ["Palantir"],
  SHOP: ["Shopify"],
  UBER: ["Uber Technologies"],
  ORCL: ["Oracle"],
  CRM: ["Salesforce"],
  AVGO: ["Broadcom"],
  QCOM: ["Qualcomm"],
  TSM: ["TSMC", "Taiwan Semiconductor"],
  BRKB: ["Berkshire Hathaway"],
  "BRK.B": ["Berkshire Hathaway"],
  "BRK-B": ["Berkshire Hathaway"],
};

/**
 * Tickers that are also common English words, short acronyms or finance jargon. A bare uppercase hit is NOT enough;
 * these need a cashtag ($ARM), an exchange prefix ("NASDAQ: ARM") or a name alias.
 */
export const AMBIGUOUS_TICKERS = new Set([
  "A", "ALL", "ARM", "ON", "IT", "FOR", "NOW", "ONE", "OPEN", "LOW", "BIG", "SO", "TRUE", "WELL", "FAST", "KEY", "REAL",
  "GOOD", "LINK", "UNI", "DOT", "NEAR", "ATOM", "SAND", "GAS", "CAKE", "AI", "ALLY", "COST", "CARE", "HAS", "BE", "BY",
  "AN", "AM", "ARE", "CAN", "CAR", "DAY", "EAT", "FUN", "GO", "HE", "HOT", "LOVE", "MAN", "MAX", "NEW", "OLD", "OUT",
  "PAY", "PLAY", "RUN", "SEE", "SUN", "TOP", "UP", "WAY", "WIN", "YOU", "CEO", "CFO", "IPO", "ETF", "GDP", "CPI", "PPI",
  "SEC", "FED", "USA", "USD", "EPS", "FOMC", "ECB", "IMF", "OPEC", "NYSE", "US", "UK", "EU", "AT", "IN", "TO", "OR",
  "ADA", "APE", "ELF", "FLY", "GAP", "GEN", "HUGE", "LIFE", "LUV", "MAIN", "PEAK", "POOL", "RARE", "SAVE", "TECH", "VIA",
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EXCHANGE = "(?:NASDAQ|NYSE|AMEX|NYSEARCA|NYSEAMERICAN|OTC|CBOE|TSX|LSE)";

function isMostlyUpper(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 12) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.7;
}

export type Matcher = { match(text: string): string[] };

export function buildMatcher(
  symbols: Map<string, AssetClass>,
  extraAliases: Record<string, string[]> = {},
): Matcher {
  type Entry = { symbol: string; cash: RegExp; exch: RegExp; bare: RegExp | null; names: RegExp[] };
  const entries: Entry[] = [];
  for (const [symbol, cls] of symbols) {
    const sym = escapeRe(symbol);
    const ambiguous = symbol.length <= 2 || AMBIGUOUS_TICKERS.has(symbol);
    const aliasNames = [...(DEFAULT_ALIASES[symbol] ?? []), ...(extraAliases[symbol] ?? [])].filter((n) => n.length >= 3);
    const flags = cls === "crypto" ? "i" : "";
    entries.push({
      symbol,
      cash: new RegExp(`(?<![A-Za-z0-9$])\\$${sym}(?![A-Za-z0-9])`, "i"),
      exch: new RegExp(`${EXCHANGE}\\s*:\\s*${sym}(?![A-Za-z0-9])`, "i"),
      bare: ambiguous ? null : new RegExp(`(?<![A-Za-z0-9$.\\-])${sym}(?![A-Za-z0-9])`),
      names: aliasNames.map((n) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, flags)),
    });
  }
  return {
    match(text: string): string[] {
      if (!text) return [];
      const shouting = isMostlyUpper(text);
      const found: string[] = [];
      for (const e of entries) {
        const hit =
          e.cash.test(text) ||
          e.exch.test(text) ||
          (!shouting && e.bare !== null && e.bare.test(text)) ||
          (!shouting && e.names.some((r) => r.test(text)));
        if (hit) found.push(e.symbol);
      }
      return found;
    },
  };
}
