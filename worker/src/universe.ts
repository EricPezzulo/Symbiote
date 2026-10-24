import type { Logger, PriceProvider } from "./types.js";
import { diffSets, type SymbolSets } from "./symbols.js";

/** Applies universe snapshots to providers as subscribe/unsubscribe diffs. */
export class UniverseSync {
  private stocks = new Set<string>();
  private crypto = new Set<string>();

  constructor(
    private readonly stockProvider: PriceProvider | null,
    private readonly cryptoProvider: PriceProvider | null,
    private readonly log: Logger,
  ) {}

  apply(next: SymbolSets) {
    this.sync("stock", this.stockProvider, this.stocks, next.stocks);
    this.sync("crypto", this.cryptoProvider, this.crypto, next.crypto);
    this.stocks = new Set(next.stocks);
    this.crypto = new Set(next.crypto);
  }

  counts() {
    return { stocks: this.stocks.size, crypto: this.crypto.size };
  }

  private sync(label: string, provider: PriceProvider | null, cur: Set<string>, next: Set<string>) {
    const { added, removed } = diffSets(cur, next);
    if (!added.length && !removed.length) return;
    if (!provider) {
      if (added.length) this.log.warn(`no ${label} provider configured; symbols will not be priced`, { count: added.length });
      return;
    }
    this.log.info(`${label} universe changed`, { added: added.length, removed: removed.length, total: next.size });
    if (removed.length) provider.unsubscribe(removed);
    if (added.length) provider.subscribe(added);
  }
}
