import { getAddress, isAddress } from "viem";

export type EvmBalance = {
  symbol: string;
  /** Decimal string in whole units (e.g. "1.5"), never a float. */
  balance: string;
  contract?: string; // undefined for native
};

export interface EvmBalanceProvider {
  getBalances(address: string): Promise<EvmBalance[]>;
}

export class EvmAddressError extends Error {}

/** Validates (checksum enforced for mixed-case input) and returns the checksummed address. */
export function normaliseEvmAddress(input: string): string {
  const a = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new EvmAddressError("Not a valid EVM address (expected 0x + 40 hex characters).");
  const mixed = a.slice(2) !== a.slice(2).toLowerCase() && a.slice(2) !== a.slice(2).toUpperCase();
  if (mixed && !isAddress(a, { strict: true })) {
    throw new EvmAddressError("Address checksum is invalid. Check for typos.");
  }
  return getAddress(a.toLowerCase());
}
