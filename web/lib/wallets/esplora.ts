// Minimal Esplora (mempool.space) client: batched, concurrency-limited, with
// timeouts and 429/5xx retry. Injectable fetch for tests.

export type AddressStats = { address: string; balanceSats: bigint; txCount: number };

export interface EsploraClient {
  /** Returns stats in the same order as the input addresses. */
  getAddressStats(addresses: string[]): Promise<AddressStats[]>;
}

type EsploraAddress = {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
};

export function createMempoolClient(opts: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
} = {}): EsploraClient {
  const base = (opts.baseUrl ?? "https://mempool.space/api").replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const concurrency = opts.concurrency ?? 4;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function one(address: string): Promise<AddressStats> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await doFetch(`${base}/address/${encodeURIComponent(address)}`, { signal: ctl.signal });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Esplora HTTP ${res.status}`);
          const ra = Number(res.headers.get("retry-after"));
          await sleep(ra > 0 ? ra * 1000 : backoffMs * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`Esplora HTTP ${res.status}`);
        const j = (await res.json()) as EsploraAddress;
        const bal =
          BigInt(j.chain_stats.funded_txo_sum) - BigInt(j.chain_stats.spent_txo_sum) +
          BigInt(j.mempool_stats.funded_txo_sum) - BigInt(j.mempool_stats.spent_txo_sum);
        return { address, balanceSats: bal, txCount: j.chain_stats.tx_count + j.mempool_stats.tx_count };
      } catch (e) {
        lastErr = e;
        if (e instanceof Error && e.message.startsWith("Esplora HTTP 4")) throw e;
        await sleep(backoffMs * 2 ** attempt);
      } finally {
        clearTimeout(t);
      }
    }
    throw new Error(`Esplora request failed: ${lastErr instanceof Error ? lastErr.message : "unknown error"}`);
  }

  return {
    async getAddressStats(addresses) {
      const results: AddressStats[] = new Array(addresses.length);
      let next = 0;
      const worker = async () => {
        while (next < addresses.length) {
          const i = next++;
          results[i] = await one(addresses[i]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
      return results;
    },
  };
}
