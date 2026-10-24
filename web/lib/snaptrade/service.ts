import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt, encrypt } from "@/lib/crypto";
import { ensureAccount, replaceSourceHoldings, writeSnapshots } from "@/lib/holdings/service";
import { getSnaptrade } from "./client";
import { mapSnaptradePositions } from "./map";

// The browser can never read connections.secret_encrypted (column grant revoked),
// so every secret read/write goes through the admin client, always scoped by the
// verified user id passed in by the caller (from supabase.auth.getUser()).

type Creds = { userId: string; userSecret: string };

type ConnRow = {
  id: string;
  external_user_id: string | null;
  secret_encrypted: string | null;
  metadata: Record<string, unknown>;
  status: string;
};

async function loadConnections(appUserId: string): Promise<ConnRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("connections")
    .select("id,external_user_id,secret_encrypted,metadata,status")
    .eq("user_id", appUserId)
    .eq("provider", "snaptrade")
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as ConnRow[];
}

function credsFrom(rows: ConnRow[]): Creds | null {
  const row = rows.find((r) => r.external_user_id && r.secret_encrypted);
  if (!row) return null;
  return { userId: row.external_user_id!, userSecret: decrypt(row.secret_encrypted!) };
}

/** Returns existing SnapTrade credentials for this app user, registering them if needed. */
export async function getOrRegisterSnaptradeUser(appUserId: string): Promise<Creds> {
  const existing = credsFrom(await loadConnections(appUserId));
  if (existing) return existing;

  const snaptrade = getSnaptrade();
  const stUserId = randomUUID(); // opaque id; no PII sent to SnapTrade
  const { data } = await snaptrade.authentication.registerSnapTradeUser({ userId: stUserId });
  if (!data.userSecret) throw new Error("SnapTrade did not return a user secret");

  const admin = createAdminClient();
  const { error } = await admin.from("connections").insert({
    user_id: appUserId,
    provider: "snaptrade",
    label: "SnapTrade",
    external_user_id: stUserId,
    secret_encrypted: encrypt(data.userSecret),
    status: "active",
    metadata: {},
  });
  if (error) throw new Error(`Saving SnapTrade registration failed: ${error.message}`);
  return { userId: stUserId, userSecret: data.userSecret };
}

export async function createLoginUrl(appUserId: string, redirectUrl: string): Promise<string> {
  const creds = await getOrRegisterSnaptradeUser(appUserId);
  const { data } = await getSnaptrade().authentication.loginSnapTradeUser({
    userId: creds.userId,
    userSecret: creds.userSecret,
    customRedirect: redirectUrl,
    connectionType: "read",
    immediateRedirect: true,
  });
  const url = (data as { redirectURI?: string }).redirectURI;
  if (!url) throw new Error("SnapTrade did not return a connection portal URL");
  return url;
}

export type SnaptradeSyncResult = { authorizations: number; accounts: number; positions: number };

/** Pull authorizations, accounts and positions; write them as source='snaptrade'. */
export async function syncSnaptrade(userClient: SupabaseClient, appUserId: string): Promise<SnaptradeSyncResult> {
  const rows = await loadConnections(appUserId);
  const creds = credsFrom(rows);
  if (!creds) throw new Error("No SnapTrade link yet");
  const snaptrade = getSnaptrade();
  const admin = createAdminClient();

  const { data: auths } = await snaptrade.connections.listBrokerageAuthorizations(creds);

  // Map each authorization to a connections row (reuse the bare registration row first).
  const connByAuth = new Map<string, string>();
  const spare = rows.find((r) => !r.metadata?.authorization_id);
  let spareUsed = false;
  for (const a of auths) {
    if (!a.id) continue;
    const existing = rows.find((r) => r.metadata?.authorization_id === a.id);
    const metadata = { authorization_id: a.id, brokerage: a.brokerage?.name ?? null, disabled: Boolean(a.disabled) };
    const patch = {
      label: a.name ?? a.brokerage?.display_name ?? "Brokerage",
      status: a.disabled ? "disabled" : "active",
      metadata,
      last_synced_at: new Date().toISOString(),
      last_error: null,
    };
    if (existing) {
      await admin.from("connections").update(patch).eq("id", existing.id).eq("user_id", appUserId);
      connByAuth.set(a.id, existing.id);
    } else if (spare && !spareUsed) {
      spareUsed = true;
      await admin.from("connections").update(patch).eq("id", spare.id).eq("user_id", appUserId);
      connByAuth.set(a.id, spare.id);
    } else {
      const { data, error } = await admin
        .from("connections")
        .insert({
          user_id: appUserId,
          provider: "snaptrade",
          external_user_id: creds.userId,
          secret_encrypted: encrypt(creds.userSecret),
          ...patch,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Saving connection failed: ${error.message}`);
      connByAuth.set(a.id, data.id);
    }
  }

  const { data: stAccounts } = await snaptrade.accountInformation.listUserAccounts(creds);
  let positionCount = 0;
  let accountCount = 0;
  for (const acct of stAccounts) {
    const connId = connByAuth.get(acct.brokerage_authorization);
    if (!connId) continue;
    const accountId = await ensureAccount(userClient, appUserId, {
      connection_id: connId,
      external_id: acct.id,
      name: acct.name ?? `${acct.institution_name} ${acct.number.slice(-4)}`,
      type: "brokerage",
      institution: acct.institution_name,
      currency: "USD",
    });
    const { data: holdings } = await snaptrade.accountInformation.getUserHoldings({
      ...creds,
      accountId: acct.id,
    });
    const mapped = mapSnaptradePositions(holdings.positions ?? []);
    await replaceSourceHoldings(userClient, appUserId, accountId, "snaptrade", mapped);
    positionCount += mapped.length;
    accountCount++;
  }

  await writeSnapshots(userClient, appUserId);
  return { authorizations: connByAuth.size, accounts: accountCount, positions: positionCount };
}

/** Disconnect a brokerage: revoke at SnapTrade, remove its accounts/holdings, free the slot. */
export async function removeSnaptradeConnection(appUserId: string, connectionId: string) {
  const rows = await loadConnections(appUserId);
  const row = rows.find((r) => r.id === connectionId);
  if (!row) throw new Error("Connection not found");
  const creds = credsFrom(rows);
  const authId = row.metadata?.authorization_id as string | undefined;
  const admin = createAdminClient();

  if (creds && authId) {
    try {
      await getSnaptrade().connections.deleteConnection({ ...creds, connectionId: authId });
    } catch (e) {
      // A 404 means it is already gone upstream; anything else should surface.
      if ((e as { status?: number })?.status !== 404) throw e;
    }
  }
  await admin.from("accounts").delete().eq("user_id", appUserId).eq("connection_id", connectionId);
  if (rows.length === 1) {
    // Keep the registration (and secret) so re-linking reuses the same SnapTrade user.
    await admin.from("connections").update({ metadata: {}, label: "SnapTrade", status: "active" }).eq("id", connectionId).eq("user_id", appUserId);
  } else {
    await admin.from("connections").delete().eq("id", connectionId).eq("user_id", appUserId);
  }
}
