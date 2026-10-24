import { formatUnits } from "viem";
import type { EvmBalance, EvmBalanceProvider } from "./evm";

type RpcResponse<T> = { result?: T; error?: { message: string } };

export function createAlchemyProvider(opts: {
  apiKey: string;
  network?: string; // e.g. "eth-mainnet"
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
}): EvmBalanceProvider {
  const url = `https://${opts.network ?? "eth-mainnet"}.g.alchemy.com/v2/${opts.apiKey}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxTokens = opts.maxTokens ?? 100;
  let id = 0;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: ctl.signal,
      });
      // Never include the URL (it embeds the API key) in errors.
      if (!res.ok) throw new Error(`Alchemy ${method} failed: HTTP ${res.status}`);
      const j = (await res.json()) as RpcResponse<T>;
      if (j.error) throw new Error(`Alchemy ${method} error: ${j.error.message}`);
      return j.result as T;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async getBalances(address) {
      const out: EvmBalance[] = [];
      const wei = BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));
      if (wei > 0n) out.push({ symbol: "ETH", balance: formatUnits(wei, 18) });

      const tokens = await rpc<{ tokenBalances: { contractAddress: string; tokenBalance: string | null }[] }>(
        "alchemy_getTokenBalances",
        [address, "erc20"],
      );
      const nonZero = tokens.tokenBalances
        .filter((t) => t.tokenBalance && BigInt(t.tokenBalance) > 0n)
        .slice(0, maxTokens);
      for (const t of nonZero) {
        const meta = await rpc<{ decimals: number | null; symbol: string | null }>("alchemy_getTokenMetadata", [
          t.contractAddress,
        ]);
        // Skip unlabeled tokens and obvious spam (long / non-alphanumeric symbols).
        if (!meta.symbol || meta.decimals == null || !/^[A-Za-z0-9]{1,12}$/.test(meta.symbol)) continue;
        out.push({
          symbol: meta.symbol.toUpperCase(),
          balance: formatUnits(BigInt(t.tokenBalance!), meta.decimals),
          contract: t.contractAddress.toLowerCase(),
        });
      }
      return out;
    },
  };
}
