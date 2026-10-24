import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/form-bits";
import { createClient } from "@/lib/supabase/server";
import { isAdminConfigured } from "@/lib/supabase/admin";
import { isEncryptionConfigured } from "@/lib/crypto";
import { isSnaptradeConfigured } from "@/lib/snaptrade/client";
import { SNAPTRADE_SLOT_CAP, slotsMessage } from "@/lib/snaptrade/map";
import { isEvmProviderConfigured } from "@/lib/wallets/server";
import {
  confirmAddressMatch,
  deleteWallet,
  disconnectSnaptrade,
  issueChallenge,
} from "./actions";
import { AddWalletForm, CsvImport, RefreshBalances, SignatureForm, SnaptradeButtons } from "./forms";

export default function Page({ searchParams }: { searchParams: Promise<{ snaptrade?: string }> }) {
  return (
    <>
      <PageHeader title="Connections" description="Brokerages and wallets." />
      <Suspense fallback={null}>
        <Flash searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading connections...</p>}>
        <Connections />
      </Suspense>
    </>
  );
}

const STATUS_COPY: Record<string, string> = {
  connected: "Brokerage connected and synced.",
  error: "SnapTrade sync failed. Try Sync now, or check server logs.",
  unconfigured: "SnapTrade is not fully configured on this server.",
};

async function Connections() {
  const supabase = await createClient();
  const [connRes, walletRes, slotRes] = await Promise.all([
    supabase.from("connections").select("id,provider,label,status,last_synced_at,last_error,metadata").eq("provider", "snaptrade"),
    supabase
      .from("wallets")
      .select("id,label,chain,kind,public_key,script_type,first_address,verified_at,verification_method,challenge,challenge_expires_at,last_synced_at")
      .order("created_at"),
    supabase.rpc("snaptrade_slots_used"),
  ]);
  const wallets = walletRes.data ?? [];
  const snapConns = (connRes.data ?? []).filter((c) => (c.metadata as Record<string, unknown>)?.authorization_id);
  const hasRegistration = (connRes.data ?? []).length > 0;
  const used = Number(slotRes.data ?? 0);
  const blocked = slotsMessage(used);

  const walletIds = wallets.map((w) => w.id);
  const { data: accts } = walletIds.length
    ? await supabase.from("accounts").select("id,wallet_id").in("wallet_id", walletIds)
    : { data: [] as { id: string; wallet_id: string }[] };
  const { data: holds } = accts?.length
    ? await supabase.from("holdings").select("account_id,symbol,quantity").in("account_id", accts.map((a) => a.id))
    : { data: [] as { account_id: string; symbol: string; quantity: number }[] };

  const configured = isSnaptradeConfigured();
  const fullyReady = configured && isEncryptionConfigured() && isAdminConfigured();

  return (
    <div className="space-y-10">
      {/* ---------------------------------------------------------- SnapTrade */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Brokerage (SnapTrade)</h2>
          <Badge tone={used >= SNAPTRADE_SLOT_CAP ? "warn" : "default"}>{used} of {SNAPTRADE_SLOT_CAP} slots used</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          The free SnapTrade tier allows {SNAPTRADE_SLOT_CAP} brokerage connections across all Symbiote users.
        </p>
        {!fullyReady ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            SnapTrade is not configured. Set <code>SNAPTRADE_CLIENT_ID</code>, <code>SNAPTRADE_CONSUMER_KEY</code>,{" "}
            <code>ENCRYPTION_KEY</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> to enable live brokerage sync. The CSV import below works without them.
          </div>
        ) : (
          <>
            {blocked && <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{blocked}</p>}
            <SnaptradeButtons canLink={!blocked} hasLink={hasRegistration} />
          </>
        )}
        {snapConns.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {snapConns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="font-medium">{c.label}</span>
                <Badge tone={c.status === "active" ? "good" : "warn"}>{c.status}</Badge>
                <span className="text-xs text-muted-foreground">
                  {c.last_synced_at ? `synced ${new Date(c.last_synced_at).toLocaleString()}` : "not synced"}
                </span>
                {fullyReady && (
                  <form action={disconnectSnaptrade} className="ml-auto">
                    <input type="hidden" name="id" value={c.id} />
                    <Button type="submit" variant="ghost" size="xs">Disconnect</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------ CSV */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Fidelity CSV import</h2>
        <p className="text-sm text-muted-foreground">
          In Fidelity, open Positions, choose the download icon, and pick &ldquo;Download&rdquo; (CSV). The file is parsed here, previewed, then saved as source &ldquo;CSV&rdquo;.
        </p>
        <CsvImport />
      </section>

      {/* --------------------------------------------------------- Wallets */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Wallets (watch-only)</h2>
        <div role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <strong>Never enter a seed phrase or private key.</strong> Symbiote only needs a public key (xpub/ypub/zpub) or an address, which can read balances but cannot move funds.
        </div>
        <AddWalletForm evmConfigured={isEvmProviderConfigured()} />
        {wallets.length > 0 && <RefreshBalances />}

        {wallets.map((w) => {
          const acct = accts?.find((a) => a.wallet_id === w.id);
          const hs = (holds ?? []).filter((h) => h.account_id === acct?.id);
          const challengeLive = w.challenge && w.challenge_expires_at && new Date(w.challenge_expires_at) > new Date();
          return (
            <div key={w.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{w.label}</h3>
                <Badge tone="muted">{w.chain === "btc" ? `BTC ${w.script_type}` : "EVM"}</Badge>
                {w.verified_at ? (
                  <Badge tone="good">Verified ({w.verification_method === "signed_message" ? "signed message" : "address match"})</Badge>
                ) : (
                  <Badge tone="warn">Watch-only, unverified</Badge>
                )}
                <form action={deleteWallet} className="ml-auto">
                  <input type="hidden" name="id" value={w.id} />
                  <Button type="submit" variant="ghost" size="xs">Delete</Button>
                </form>
              </div>
              <p className="break-all font-mono text-xs text-muted-foreground">{w.chain === "btc" ? w.public_key.slice(0, 12) + "..." + w.public_key.slice(-6) : w.public_key}</p>
              <div className="text-sm">
                {hs.length === 0 ? (
                  <span className="text-muted-foreground">
                    No balances yet{w.last_synced_at ? " (wallet is empty)" : ". Use Refresh balances"}.
                  </span>
                ) : (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1">
                    {hs.map((h) => <li key={h.symbol} className="tabular-nums"><strong>{Number(h.quantity)}</strong> {h.symbol}</li>)}
                  </ul>
                )}
              </div>

              {!w.verified_at && (
                <div className="space-y-3 border-t pt-3 text-sm">
                  <div className="space-y-2">
                    <p className="font-medium">Verify: match the address in Trezor Suite</p>
                    <p className="text-muted-foreground">
                      Open this account in Trezor Suite and compare its first receive address with the one below, ideally confirmed on the Trezor screen.
                    </p>
                    <p className="break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{w.first_address}</p>
                    <form action={confirmAddressMatch}>
                      <input type="hidden" name="id" value={w.id} />
                      <Button type="submit" size="sm">It matches</Button>
                    </form>
                  </div>
                  {w.chain === "evm" ? (
                    <div className="space-y-2">
                      <p className="font-medium">Or prove ownership with a signed message (optional)</p>
                      {challengeLive ? (
                        <>
                          <p className="text-muted-foreground">
                            Sign this exact message with <code>personal_sign</code> (Trezor Suite: Tools &rarr; Sign &amp; verify message), then paste the signature. Expires {new Date(w.challenge_expires_at!).toLocaleTimeString()}.
                          </p>
                          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{w.challenge}</pre>
                          <SignatureForm walletId={w.id} />
                        </>
                      ) : (
                        <form action={issueChallenge}>
                          <input type="hidden" name="id" value={w.id} />
                          <Button type="submit" variant="outline" size="sm">Generate challenge</Button>
                        </form>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Signed-message proof for Bitcoin is not available yet; use the address match above.</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

async function Flash({ searchParams }: { searchParams: Promise<{ snaptrade?: string }> }) {
  const { snaptrade } = await searchParams;
  const msg = snaptrade ? STATUS_COPY[snaptrade] : null;
  if (!msg) return null;
  return (
    <p role="status" className="mb-6 rounded-lg border p-3 text-sm">
      {msg}
    </p>
  );
}
