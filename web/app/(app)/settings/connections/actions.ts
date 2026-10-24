"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { errState, okState, requireUser, type ActionState } from "@/lib/auth";
import { isEncryptionConfigured } from "@/lib/crypto";
import { isAdminConfigured } from "@/lib/supabase/admin";
import { ensureAccount, replaceSourceHoldings, writeSnapshots } from "@/lib/holdings/service";
import { groupByAccount, parseFidelityCsv } from "@/lib/import/fidelity";
import { isSnaptradeConfigured, describeSnaptradeError } from "@/lib/snaptrade/client";
import { slotsMessage } from "@/lib/snaptrade/map";
import { createLoginUrl, removeSnaptradeConnection, syncSnaptrade } from "@/lib/snaptrade/service";
import { firstReceiveAddress, WalletInputError } from "@/lib/wallets/btc";
import { EvmAddressError, normaliseEvmAddress } from "@/lib/wallets/evm";
import { buildChallenge, challengeValid, CHALLENGE_TTL_MS, verifyEvmSignature } from "@/lib/wallets/verify";
import { getEsplora, getEvmProvider, isEvmProviderConfigured } from "@/lib/wallets/server";
import { syncWalletAndSnapshot, type WalletRow } from "@/lib/wallets/sync";

type State = ActionState | null;

function refresh() {
  revalidatePath("/settings/connections");
  revalidatePath("/holdings");
  revalidatePath("/");
}

// ------------------------------------------------------------- Fidelity CSV

const MAX_CSV_BYTES = 2_000_000;

export async function importFidelityCsv(_prev: State, fd: FormData): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const text = fd.get("csv");
  if (typeof text !== "string" || text.length === 0) return errState("Choose a CSV file first.");
  if (text.length > MAX_CSV_BYTES) return errState("That file is too large for a positions export.");

  // Always re-parse server-side; the client preview is advisory only.
  const parsed = parseFidelityCsv(text);
  if (parsed.errors.length) return errState(parsed.errors[0]);

  try {
    let { data: conn } = await supabase
      .from("connections")
      .select("id")
      .eq("user_id", user.id)
      .eq("provider", "csv")
      .eq("label", "Fidelity CSV")
      .maybeSingle();
    if (!conn) {
      const ins = await supabase
        .from("connections")
        .insert({ user_id: user.id, provider: "csv", label: "Fidelity CSV" })
        .select("id")
        .single();
      if (ins.error) throw new Error(ins.error.message);
      conn = ins.data;
    }
    const groups = groupByAccount(parsed.rows);
    for (const g of groups) {
      const accountId = await ensureAccount(supabase, user.id, {
        connection_id: conn.id,
        external_id: g.number,
        name: g.name === g.number ? `Fidelity ${g.number.slice(-4)}` : g.name,
        type: "brokerage",
        institution: "Fidelity",
      });
      await replaceSourceHoldings(
        supabase,
        user.id,
        accountId,
        "csv",
        g.rows.map((r) => ({
          symbol: r.symbol,
          asset_type: r.assetType,
          quantity: r.quantity,
          cost_basis: r.costBasis,
        })),
      );
    }
    await supabase
      .from("connections")
      .update({ last_synced_at: new Date().toISOString(), last_error: null })
      .eq("id", conn.id)
      .eq("user_id", user.id);
    await writeSnapshots(supabase, user.id);
    refresh();
    return okState(
      `Imported ${parsed.rows.length} positions into ${groups.length} account(s); ${parsed.skipped.length} line(s) skipped.`,
    );
  } catch (e) {
    return errState(e instanceof Error ? e.message : "Import failed.");
  }
}

// ---------------------------------------------------------------- SnapTrade

async function siteOrigin() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function snaptradeReady(): string | null {
  if (!isSnaptradeConfigured()) return "SnapTrade is not configured on this server.";
  if (!isEncryptionConfigured()) return "ENCRYPTION_KEY is not configured on this server.";
  if (!isAdminConfigured()) return "SUPABASE_SERVICE_ROLE_KEY is not configured on this server.";
  return null;
}

export async function connectSnaptrade(_prev: State): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const notReady = snaptradeReady();
  if (notReady) return errState(notReady);

  const { data: used, error } = await supabase.rpc("snaptrade_slots_used");
  if (error) return errState("Could not check SnapTrade slot usage.");
  const blocked = slotsMessage(Number(used));
  if (blocked) return errState(blocked);

  let url: string;
  try {
    url = await createLoginUrl(user.id, `${await siteOrigin()}/snaptrade/callback`);
  } catch (e) {
    return errState(`SnapTrade error: ${describeSnaptradeError(e)}`);
  }
  redirect(url);
}

export async function syncSnaptradeNow(_prev: State): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const notReady = snaptradeReady();
  if (notReady) return errState(notReady);
  try {
    const r = await syncSnaptrade(supabase, user.id);
    refresh();
    return okState(`Synced ${r.positions} positions across ${r.accounts} account(s).`);
  } catch (e) {
    return errState(`Sync failed: ${describeSnaptradeError(e)}`);
  }
}

export async function disconnectSnaptrade(fd: FormData): Promise<void> {
  const { user } = await requireUser();
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success || snaptradeReady()) return;
  try {
    await removeSnaptradeConnection(user.id, id.data);
  } catch {
    // Surfaced on next page load via connection status; never log secrets.
  }
  refresh();
}

// ------------------------------------------------------------------ Wallets

const addWalletSchema = z.object({
  chain: z.enum(["btc", "evm"]),
  label: z.string().trim().min(1, "Label is required").max(60),
  key: z.string().trim().min(1, "Enter an xpub/ypub/zpub or an address").max(200),
});

export async function addWallet(_prev: State, fd: FormData): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const parsed = addWalletSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return errState(parsed.error.issues[0]?.message ?? "Invalid input");
  const { chain, label, key } = parsed.data;

  let row: Record<string, unknown>;
  try {
    if (chain === "btc") {
      const { address, scriptType } = firstReceiveAddress(key);
      row = { kind: "xpub", public_key: key, script_type: scriptType, first_address: address };
    } else {
      const address = normaliseEvmAddress(key);
      row = { kind: "address", public_key: address, first_address: address };
    }
  } catch (e) {
    if (e instanceof WalletInputError || e instanceof EvmAddressError) return errState(e.message);
    return errState("Could not parse that key.");
  }

  const { data, error } = await supabase
    .from("wallets")
    .insert({ user_id: user.id, chain, label, ...row })
    .select("id,label,chain,public_key")
    .single();
  if (error) {
    return errState(error.code === "23505" ? "That wallet is already added." : "Could not save wallet.");
  }
  await supabase
    .from("accounts")
    .insert({ user_id: user.id, wallet_id: data.id, name: label, type: "crypto_wallet", institution: "Trezor" });
  refresh();
  return okState("Wallet added (watch-only). Verify it below, then refresh balances.");
}

export async function deleteWallet(fd: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return;
  await supabase.from("wallets").delete().eq("id", id.data).eq("user_id", user.id); // account + holdings cascade
  refresh();
}

export async function confirmAddressMatch(fd: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return;
  await supabase
    .from("wallets")
    .update({ verified_at: new Date().toISOString(), verification_method: "address_match" })
    .eq("id", id.data)
    .eq("user_id", user.id)
    .is("verified_at", null);
  refresh();
}

export async function issueChallenge(fd: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return;
  const { data: w } = await supabase
    .from("wallets")
    .select("label,chain,public_key")
    .eq("id", id.data)
    .eq("user_id", user.id)
    .single();
  if (!w || w.chain !== "evm") return; // BTC message signing: TODO (see README)
  await supabase
    .from("wallets")
    .update({
      challenge: buildChallenge(w.label, w.public_key),
      challenge_expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    })
    .eq("id", id.data)
    .eq("user_id", user.id);
  refresh();
}

export async function submitSignature(_prev: State, fd: FormData): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const parsed = z.object({ id: z.uuid(), signature: z.string().trim().min(10).max(400) }).safeParse(Object.fromEntries(fd));
  if (!parsed.success) return errState("Paste the signature from your wallet.");
  const { data: w } = await supabase
    .from("wallets")
    .select("chain,public_key,challenge,challenge_expires_at")
    .eq("id", parsed.data.id)
    .eq("user_id", user.id)
    .single();
  if (!w || w.chain !== "evm") return errState("Signed-message proof is only available for EVM wallets.");
  if (!challengeValid(w.challenge, w.challenge_expires_at)) return errState("Challenge expired. Generate a new one.");
  if (!(await verifyEvmSignature(w.public_key, w.challenge!, parsed.data.signature))) {
    return errState("Signature does not match this address and challenge.");
  }
  // One-time: clear the challenge so it cannot be replayed.
  await supabase
    .from("wallets")
    .update({
      verified_at: new Date().toISOString(),
      verification_method: "signed_message",
      challenge: null,
      challenge_expires_at: null,
    })
    .eq("id", parsed.data.id)
    .eq("user_id", user.id);
  refresh();
  return okState("Ownership proven by signature.");
}

export async function refreshBalances(_prev: State): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const { data: wallets, error } = await supabase.from("wallets").select("id,label,chain,public_key");
  if (error) return errState("Could not load wallets.");
  if (!wallets?.length) return errState("No wallets to refresh.");
  const problems: string[] = [];
  let synced = 0;
  for (const w of wallets as WalletRow[]) {
    if (w.chain === "evm" && !isEvmProviderConfigured()) {
      problems.push(`${w.label}: ALCHEMY_API_KEY is not configured`);
      continue;
    }
    try {
      await syncWalletAndSnapshot(supabase, user.id, w, { esplora: getEsplora, evm: getEvmProvider });
      synced++;
    } catch (e) {
      problems.push(`${w.label}: ${e instanceof Error ? e.message.slice(0, 160) : "failed"}`);
    }
  }
  refresh();
  if (problems.length) return { ok: synced > 0, message: synced ? `Refreshed ${synced} wallet(s).` : undefined, error: problems.join("; ") };
  return okState(`Refreshed ${synced} wallet(s).`);
}
