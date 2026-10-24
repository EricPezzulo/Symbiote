import { randomBytes } from "node:crypto";
import { verifyMessage, type Hex } from "viem";

export const CHALLENGE_TTL_MS = 15 * 60 * 1000;

export function buildChallenge(label: string, address: string, now = new Date()): string {
  const nonce = randomBytes(16).toString("hex");
  return `Symbiote wallet ownership proof\nWallet: ${label.slice(0, 60)}\nAddress: ${address}\nNonce: ${nonce}\nIssued: ${now.toISOString()}`;
}

/** EVM personal_sign proof via viem. Returns false on any malformed input. */
export async function verifyEvmSignature(address: string, message: string, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({ address: address as Hex, message, signature: signature.trim() as Hex });
  } catch {
    return false;
  }
}

export function challengeValid(challenge: string | null, expiresAt: string | null, now = new Date()): boolean {
  return Boolean(challenge && expiresAt && new Date(expiresAt).getTime() > now.getTime());
}
