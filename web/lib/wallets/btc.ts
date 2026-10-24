import { HDKey } from "@scure/bip32";
import { base58, bech32, createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import type { EsploraClient } from "./esplora";

export type ScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh";

const b58check = createBase58check(sha256);

// SLIP-132 public version bytes (mainnet).
const VERSIONS: Record<string, { bytes: number; script: ScriptType }> = {
  xpub: { bytes: 0x0488b21e, script: "p2pkh" }, // BIP44
  ypub: { bytes: 0x049d7cb2, script: "p2sh-p2wpkh" }, // BIP49
  zpub: { bytes: 0x04b24746, script: "p2wpkh" }, // BIP84
};
const XPUB_VERSION = 0x0488b21e;

export class WalletInputError extends Error {}

const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

export function parseExtendedPublicKey(input: string): { node: HDKey; scriptType: ScriptType; prefix: string } {
  const key = input.trim();
  if (/\s/.test(key)) {
    throw new WalletInputError("That looks like a seed phrase. Never enter a seed phrase; only a public key (xpub/ypub/zpub).");
  }
  if (/^[xyzt]prv/i.test(key)) {
    throw new WalletInputError("That is a PRIVATE key. Never enter private keys; use the public key (xpub/ypub/zpub).");
  }
  const prefix = key.slice(0, 4);
  const spec = VERSIONS[prefix];
  if (!spec) throw new WalletInputError("Unsupported key. Expected an xpub, ypub or zpub (mainnet).");
  let raw: Uint8Array;
  try {
    raw = b58check.decode(key);
  } catch {
    throw new WalletInputError("Invalid extended public key (bad checksum or encoding).");
  }
  if (raw.length !== 78) throw new WalletInputError("Invalid extended public key length.");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0) !== spec.bytes) throw new WalletInputError("Key version bytes do not match its prefix.");
  // Re-encode as a plain xpub so HDKey accepts it.
  const normalised = raw.slice();
  new DataView(normalised.buffer).setUint32(0, XPUB_VERSION);
  let node: HDKey;
  try {
    node = HDKey.fromExtendedKey(b58check.encode(normalised));
  } catch {
    throw new WalletInputError("Invalid extended public key.");
  }
  if (node.privateKey) throw new WalletInputError("Key contains private material; refusing.");
  return { node, scriptType: spec.script, prefix };
}

export function addressFromPubkey(pubkey: Uint8Array, script: ScriptType): string {
  const h = hash160(pubkey);
  switch (script) {
    case "p2pkh":
      return b58check.encode(Uint8Array.from([0x00, ...h]));
    case "p2sh-p2wpkh": {
      const redeem = Uint8Array.from([0x00, 0x14, ...h]);
      return b58check.encode(Uint8Array.from([0x05, ...hash160(redeem)]));
    }
    case "p2wpkh":
      return bech32.encode("bc", [0, ...bech32.toWords(h)]);
  }
}

/** chain 0 = receive, 1 = change. */
export function deriveAddress(node: HDKey, script: ScriptType, chain: 0 | 1, index: number): string {
  const child = node.deriveChild(chain).deriveChild(index);
  if (!child.publicKey) throw new Error("derivation failed");
  return addressFromPubkey(child.publicKey, script);
}

export function firstReceiveAddress(xpub: string): { address: string; scriptType: ScriptType } {
  const { node, scriptType } = parseExtendedPublicKey(xpub);
  return { address: deriveAddress(node, scriptType, 0, 0), scriptType };
}

export const GAP_LIMIT = 20;
const MAX_SCAN = 1000;

export type BtcScan = {
  balanceSats: bigint;
  usedAddresses: number;
  lastReceiveIndex: number;
  lastChangeIndex: number;
};

/** Scan receive+change chains until `gap` consecutive unused addresses are seen. */
export async function scanBtcWallet(
  xpub: string,
  esplora: EsploraClient,
  opts: { gap?: number } = {},
): Promise<BtcScan> {
  const gap = opts.gap ?? GAP_LIMIT;
  const { node, scriptType } = parseExtendedPublicKey(xpub);
  let balanceSats = 0n;
  let used = 0;
  const lastIdx: number[] = [-1, -1];

  for (const chain of [0, 1] as const) {
    let scanned = 0;
    let lastUsed = -1;
    for (;;) {
      const need = Math.min(lastUsed + gap + 1, MAX_SCAN);
      if (scanned >= need) break;
      const addrs: string[] = [];
      for (let i = scanned; i < need; i++) addrs.push(deriveAddress(node, scriptType, chain, i));
      const stats = await esplora.getAddressStats(addrs);
      stats.forEach((s, k) => {
        balanceSats += s.balanceSats;
        if (s.txCount > 0) {
          used++;
          lastUsed = Math.max(lastUsed, scanned + k);
        }
      });
      scanned = need;
    }
    lastIdx[chain] = lastUsed;
  }
  return { balanceSats, usedAddresses: used, lastReceiveIndex: lastIdx[0], lastChangeIndex: lastIdx[1] };
}

// Exported for tests.
export { base58 };
