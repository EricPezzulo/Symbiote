export const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

export const qty = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(n);

export const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  csv: "CSV",
  snaptrade: "SnapTrade",
  wallet: "Wallet",
};
