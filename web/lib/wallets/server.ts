import "server-only";
import { formatUnits } from "viem";
import { createMempoolClient } from "./esplora";
import { createAlchemyProvider } from "./alchemy";
import type { EvmBalanceProvider } from "./evm";

export function isEvmProviderConfigured(): boolean {
  return Boolean(process.env.ALCHEMY_API_KEY);
}

export function getEvmProvider(): EvmBalanceProvider {
  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) throw new Error("ALCHEMY_API_KEY is not configured");
  return createAlchemyProvider({ apiKey, network: process.env.ALCHEMY_NETWORK || "eth-mainnet" });
}

export function getEsplora() {
  return createMempoolClient({ baseUrl: process.env.MEMPOOL_API_URL || undefined });
}

export const satsToBtc = (sats: bigint) => formatUnits(sats, 8);
