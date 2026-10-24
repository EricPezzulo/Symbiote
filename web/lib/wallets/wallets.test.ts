import { describe, expect, it, vi } from "vitest";
import { HDKey } from "@scure/bip32";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAddress, firstReceiveAddress, parseExtendedPublicKey, scanBtcWallet, WalletInputError } from "./btc";
import { createMempoolClient, type EsploraClient } from "./esplora";
import { normaliseEvmAddress } from "./evm";
import { createAlchemyProvider } from "./alchemy";
import { buildChallenge, challengeValid, verifyEvmSignature } from "./verify";

const b58 = createBase58check(sha256);

// BIP84 spec test vector (mnemonic "abandon ... about"), account 0.
const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const SEED = Buffer.from(
  "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
  "hex",
);

function reserialise(xpub: string, version: number) {
  const raw = b58.decode(xpub).slice();
  new DataView(raw.buffer).setUint32(0, version);
  return b58.encode(raw);
}

describe("BTC derivation", () => {
  it("matches the BIP84 spec vectors", () => {
    const { node, scriptType } = parseExtendedPublicKey(BIP84_ZPUB);
    expect(scriptType).toBe("p2wpkh");
    expect(deriveAddress(node, scriptType, 0, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(deriveAddress(node, scriptType, 0, 1)).toBe("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    expect(deriveAddress(node, scriptType, 1, 0)).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
  });

  it("the BIP84 zpub equals the one derived from the seed (independent cross-check)", () => {
    const acct = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'");
    expect(reserialise(acct.publicExtendedKey, 0x04b24746)).toBe(BIP84_ZPUB);
  });

  it("derives BIP44 (xpub) and BIP49 (ypub) addresses for the same seed", () => {
    const root = HDKey.fromMasterSeed(SEED);
    const x44 = root.derive("m/44'/0'/0'").publicExtendedKey;
    expect(firstReceiveAddress(x44)).toEqual({ address: "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA", scriptType: "p2pkh" });
    const y49 = reserialise(root.derive("m/49'/0'/0'").publicExtendedKey, 0x049d7cb2);
    expect(firstReceiveAddress(y49)).toEqual({ address: "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf", scriptType: "p2sh-p2wpkh" });
  });

  it("rejects private keys, seed phrases and garbage without echoing them", () => {
    const prv = HDKey.fromMasterSeed(SEED).privateExtendedKey;
    expect(() => parseExtendedPublicKey(prv)).toThrow(/PRIVATE/);
    expect(() => parseExtendedPublicKey("abandon abandon about")).toThrow(/seed phrase/);
    expect(() => parseExtendedPublicKey("zpub-not-valid")).toThrow(WalletInputError);
    expect(() => parseExtendedPublicKey(BIP84_ZPUB.slice(0, -1) + "1")).toThrow(/checksum|Invalid/);
    try {
      parseExtendedPublicKey(prv);
    } catch (e) {
      expect(String(e)).not.toContain(prv);
    }
  });
});

describe("BTC scan with mocked Esplora", () => {
  const { node } = parseExtendedPublicKey(BIP84_ZPUB);
  const addr = (chain: 0 | 1, i: number) => deriveAddress(node, "p2wpkh", chain, i);

  function mock(funded: Record<string, { sats: bigint; txs: number }>) {
    const calls: string[] = [];
    const client: EsploraClient = {
      async getAddressStats(addresses) {
        calls.push(...addresses);
        return addresses.map((address) => ({
          address,
          balanceSats: funded[address]?.sats ?? 0n,
          txCount: funded[address]?.txs ?? 0,
        }));
      },
    };
    return { client, calls };
  }

  it("sums balances and extends the window past used addresses (gap 20)", async () => {
    const { client, calls } = mock({
      [addr(0, 0)]: { sats: 100_000n, txs: 2 },
      [addr(0, 25)]: { sats: 50_000n, txs: 1 }, // beyond the first 20 but within gap of index 0? 25-0 > 20 -> reached via extension
      [addr(1, 3)]: { sats: 7n, txs: 1 },
      [addr(0, 60)]: { sats: 999n, txs: 1 }, // unreachable: gap > 20 after index 25
    });
    const r = await scanBtcWallet(BIP84_ZPUB, client);
    // index 0 used -> scan through 20; 25 is NOT found from index 0 alone (window ends at 20)
    expect(r.balanceSats).toBe(100_007n);
    expect(r.lastReceiveIndex).toBe(0);
    expect(r.lastChangeIndex).toBe(3);
    expect(r.usedAddresses).toBe(2);
    expect(calls).toContain(addr(0, 20));
    expect(calls).not.toContain(addr(0, 21));
    expect(calls).toContain(addr(1, 23));
    expect(calls).not.toContain(addr(1, 24));
  });

  it("keeps scanning while used addresses keep appearing within the gap", async () => {
    const { client } = mock({
      [addr(0, 0)]: { sats: 1n, txs: 1 },
      [addr(0, 19)]: { sats: 2n, txs: 1 },
      [addr(0, 38)]: { sats: 4n, txs: 1 },
    });
    const r = await scanBtcWallet(BIP84_ZPUB, client);
    expect(r.balanceSats).toBe(7n);
    expect(r.lastReceiveIndex).toBe(38);
  });

  it("empty wallet scans exactly gap addresses per chain", async () => {
    const { client, calls } = mock({});
    const r = await scanBtcWallet(BIP84_ZPUB, client);
    expect(calls).toHaveLength(40);
    expect(r.balanceSats).toBe(0n);
    expect(r.lastReceiveIndex).toBe(-1);
  });
});

describe("mempool client", () => {
  const body = (f: number, s: number, tx: number) => ({
    chain_stats: { funded_txo_sum: f, spent_txo_sum: s, tx_count: tx },
    mempool_stats: { funded_txo_sum: 5, spent_txo_sum: 0, tx_count: 1 },
  });
  it("computes balance incl. mempool, preserving order", async () => {
    const fetchImpl = vi.fn(async (u: string | URL | Request) =>
      Response.json(String(u).endsWith("/a") ? body(100, 40, 2) : body(0, 0, 0)),
    ) as unknown as typeof fetch;
    const c = createMempoolClient({ fetchImpl, baseUrl: "http://x/api" });
    const r = await c.getAddressStats(["a", "b"]);
    expect(r[0]).toMatchObject({ address: "a", balanceSats: 65n, txCount: 3 });
    expect(r[1]).toMatchObject({ address: "b", balanceSats: 5n, txCount: 1 });
  });
  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl = (async () =>
      ++n < 3 ? new Response("", { status: 429 }) : Response.json(body(1, 0, 1))) as unknown as typeof fetch;
    const c = createMempoolClient({ fetchImpl, backoffMs: 1 });
    expect((await c.getAddressStats(["a"]))[0].balanceSats).toBe(6n);
    expect(n).toBe(3);
  });
  it("fails after exhausting retries", async () => {
    const fetchImpl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const c = createMempoolClient({ fetchImpl, backoffMs: 1, retries: 1 });
    await expect(c.getAddressStats(["a"])).rejects.toThrow(/failed/);
  });
});

describe("EVM", () => {
  it("validates addresses and checksums", () => {
    const lower = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const checksummed = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    expect(normaliseEvmAddress(lower)).toBe(checksummed);
    expect(normaliseEvmAddress(` ${checksummed} `)).toBe(checksummed);
    expect(() => normaliseEvmAddress("0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toThrow(/checksum/);
    expect(() => normaliseEvmAddress("0x123")).toThrow();
    expect(() => normaliseEvmAddress("vitalik.eth")).toThrow();
  });

  it("alchemy provider maps ETH + ERC-20 balances and filters spam", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_u: unknown, init: RequestInit) => {
      const { method, params } = JSON.parse(init.body as string);
      calls.push(method);
      const result =
        method === "eth_getBalance"
          ? "0xde0b6b3a7640000" // 1 ETH
          : method === "alchemy_getTokenBalances"
            ? {
                tokenBalances: [
                  { contractAddress: "0xA0b8", tokenBalance: "0x" + (2_500_000).toString(16) },
                  { contractAddress: "0xSpam", tokenBalance: "0x1" },
                  { contractAddress: "0xZero", tokenBalance: "0x0" },
                ],
              }
            : params[0] === "0xA0b8"
              ? { decimals: 6, symbol: "USDC" }
              : { decimals: 18, symbol: "Visit https://scam.example" };
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    }) as unknown as typeof fetch;
    const p = createAlchemyProvider({ apiKey: "k", fetchImpl });
    expect(await p.getBalances("0xabc")).toEqual([
      { symbol: "ETH", balance: "1" },
      { symbol: "USDC", balance: "2.5", contract: "0xa0b8" },
    ]);
  });

  it("alchemy errors never leak the API key", async () => {
    const fetchImpl = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const p = createAlchemyProvider({ apiKey: "SECRETKEY", fetchImpl });
    await expect(p.getBalances("0xabc")).rejects.not.toThrow(/SECRETKEY/);
  });
});

describe("EVM signed-message verification", () => {
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  it("accepts a valid signature and rejects wrong signer / message / garbage", async () => {
    const msg = buildChallenge("My Trezor", account.address);
    const sig = await account.signMessage({ message: msg });
    expect(await verifyEvmSignature(account.address, msg, sig)).toBe(true);
    expect(await verifyEvmSignature(account.address, msg + "x", sig)).toBe(false);
    const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    expect(await verifyEvmSignature(other.address, msg, sig)).toBe(false);
    expect(await verifyEvmSignature(account.address, msg, "0xdeadbeef")).toBe(false);
  });
  it("challenges are unique and expire", () => {
    expect(buildChallenge("a", "0x1")).not.toBe(buildChallenge("a", "0x1"));
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(challengeValid("c", future)).toBe(true);
    expect(challengeValid("c", past)).toBe(false);
    expect(challengeValid(null, future)).toBe(false);
  });
});
