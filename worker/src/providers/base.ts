import type { AssetClass, Logger, PriceProvider, ProviderStatus, Tick } from "../types.js";

/** Shared bookkeeping: desired symbol set + tick listeners. Subclasses react to changes. */
export abstract class BaseProvider implements PriceProvider {
  abstract readonly name: string;
  abstract readonly assetType: AssetClass;
  protected desired = new Set<string>();
  private listeners: Array<(t: Tick) => void> = [];

  constructor(protected readonly log: Logger) {}

  onTick(cb: (t: Tick) => void) {
    this.listeners.push(cb);
  }

  protected emit(t: Tick) {
    for (const l of this.listeners) {
      try {
        l(t);
      } catch (err) {
        this.log.error("tick listener threw", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  subscribe(symbols: string[]) {
    const added = symbols.filter((s) => !this.desired.has(s));
    for (const s of added) this.desired.add(s);
    if (added.length) this.onSubscribed(added);
  }

  unsubscribe(symbols: string[]) {
    const removed = symbols.filter((s) => this.desired.has(s));
    for (const s of removed) this.desired.delete(s);
    if (removed.length) this.onUnsubscribed(removed);
  }

  symbolCount() {
    return this.desired.size;
  }

  protected abstract onSubscribed(symbols: string[]): void;
  protected abstract onUnsubscribed(symbols: string[]): void;
  abstract start(): void | Promise<void>;
  abstract stop(): Promise<void>;
  abstract status(): ProviderStatus;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
