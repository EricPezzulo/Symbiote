/** Serializes callers with a minimum gap between releases (e.g. Finnhub free tier: 60 calls/min => >= 1s). */
export class RateLimiter {
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minGapMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  wait(): Promise<void> {
    const run = async () => {
      const t = this.now();
      const at = Math.max(t, this.nextAt);
      this.nextAt = at + this.minGapMs;
      if (at > t) await this.sleep(at - t);
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
