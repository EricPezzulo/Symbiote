"use client";

import { useActionState, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormStatus, inputClass } from "@/components/form-bits";
import { groupByAccount, parseFidelityCsv } from "@/lib/import/fidelity";
import { qty, usd } from "@/lib/format";
import {
  addWallet,
  connectSnaptrade,
  importFidelityCsv,
  refreshBalances,
  submitSignature,
  syncSnaptradeNow,
} from "./actions";

export function SnaptradeButtons({ canLink, hasLink }: { canLink: boolean; hasLink: boolean }) {
  const [cState, connect, cPending] = useActionState(connectSnaptrade, null);
  const [sState, sync, sPending] = useActionState(syncSnaptradeNow, null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <form action={connect}>
          <Button type="submit" disabled={!canLink || cPending}>{cPending ? "Opening..." : "Connect a brokerage"}</Button>
        </form>
        {hasLink && (
          <form action={sync}>
            <Button type="submit" variant="outline" disabled={sPending}>{sPending ? "Syncing..." : "Sync now"}</Button>
          </form>
        )}
      </div>
      <FormStatus state={cState} />
      <FormStatus state={sState} />
    </div>
  );
}

export function CsvImport() {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [state, action, pending] = useActionState(importFidelityCsv, null);
  const parsed = useMemo(() => (text ? parseFidelityCsv(text) : null), [text]);
  const groups = useMemo(() => (parsed ? groupByAccount(parsed.rows) : []), [parsed]);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="csv" value={text} />
      <Field label="Fidelity Portfolio Positions CSV">
        <input
          type="file"
          accept=".csv,text/csv"
          className={inputClass}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return setText("");
            if (f.size > 2_000_000) {
              setText("");
              setFileName("File too large");
              return;
            }
            setFileName(f.name);
            setText(await f.text());
          }}
        />
      </Field>
      {parsed?.errors.map((e) => <p key={e} role="alert" className="text-sm text-destructive">{e}</p>)}
      {groups.map((g) => (
        <div key={g.number} className="overflow-x-auto rounded-lg border">
          <p className="bg-muted/50 px-3 py-2 text-xs font-medium">{g.name} <span className="text-muted-foreground">({g.number})</span></p>
          <table className="w-full text-sm">
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.symbol} className="border-t">
                  <td className="px-3 py-1.5 font-medium">{r.symbol}{r.isMoneyMarket && <span className="ml-1 text-xs text-muted-foreground">cash</span>}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{r.description}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{qty(r.quantity)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.costBasis === null ? "—" : usd(r.costBasis)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {parsed && parsed.skipped.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {parsed.skipped.length} line(s) skipped: {[...new Set(parsed.skipped.map((s) => s.reason))].join(", ")}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !parsed || parsed.rows.length === 0}>
          {pending ? "Importing..." : "Import these positions"}
        </Button>
        {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Importing replaces previously imported (CSV) holdings in the same accounts; manual and SnapTrade rows are untouched unless the symbol matches.
      </p>
      <FormStatus state={state} />
    </form>
  );
}

export function AddWalletForm({ evmConfigured }: { evmConfigured: boolean }) {
  const [state, action, pending] = useActionState(addWallet, null);
  const [chain, setChain] = useState("btc");
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-6 sm:items-end">
      <Field label="Chain">
        <select name="chain" className={inputClass} value={chain} onChange={(e) => setChain(e.target.value)}>
          <option value="btc">Bitcoin</option>
          <option value="evm">Ethereum / EVM</option>
        </select>
      </Field>
      <Field label="Label">
        <input name="label" required maxLength={60} className={inputClass} placeholder="Trezor Model T" />
      </Field>
      <Field label={chain === "btc" ? "xpub / ypub / zpub" : "Address (0x...)"} className="sm:col-span-3">
        <input name="key" required autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`}
          placeholder={chain === "btc" ? "zpub6r..." : "0x..."} />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Adding..." : "Add wallet"}</Button>
      {chain === "evm" && !evmConfigured && (
        <p className="sm:col-span-6 text-xs text-amber-600 dark:text-amber-400">
          ALCHEMY_API_KEY is not set, so EVM balances cannot be fetched yet. You can still add and verify the address.
        </p>
      )}
      <div className="sm:col-span-6"><FormStatus state={state} /></div>
    </form>
  );
}

export function RefreshBalances() {
  const [state, action, pending] = useActionState(refreshBalances, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="outline" disabled={pending}>{pending ? "Refreshing..." : "Refresh balances"}</Button>
      <FormStatus state={state} />
    </form>
  );
}

export function SignatureForm({ walletId }: { walletId: string }) {
  const [state, action, pending] = useActionState(submitSignature, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={walletId} />
      <Field label="Signature (0x...)">
        <input name="signature" required autoComplete="off" className={`${inputClass} font-mono`} />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Checking..." : "Verify signature"}</Button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
