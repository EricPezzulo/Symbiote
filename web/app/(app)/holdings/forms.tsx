"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormStatus, inputClass } from "@/components/form-bits";
import { createAccount, createHolding, updateHolding } from "./actions";

export function AddAccountForm() {
  const [state, action, pending] = useActionState(createAccount, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-4 sm:items-end">
      <Field label="Account name">
        <input name="name" required maxLength={80} className={inputClass} placeholder="Roth IRA" />
      </Field>
      <Field label="Type">
        <select name="type" className={inputClass} defaultValue="brokerage">
          <option value="brokerage">Brokerage</option>
          <option value="exchange">Crypto exchange</option>
          <option value="crypto_wallet">Crypto wallet</option>
          <option value="manual">Manual</option>
        </select>
      </Field>
      <Field label="Institution (optional)">
        <input name="institution" maxLength={80} className={inputClass} placeholder="Fidelity" />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Adding..." : "Add account"}</Button>
      <div className="sm:col-span-4"><FormStatus state={state} /></div>
    </form>
  );
}

export function AddHoldingForm({ accounts }: { accounts: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createHolding, null);
  if (accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">Create an account first, then add holdings to it.</p>;
  }
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-6 sm:items-end">
      <Field label="Account" className="sm:col-span-2">
        <select name="account_id" required className={inputClass}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      <Field label="Symbol">
        <input name="symbol" required maxLength={24} className={inputClass} placeholder="AAPL" autoCapitalize="characters" />
      </Field>
      <Field label="Type">
        <select name="asset_type" className={inputClass} defaultValue="stock">
          <option value="stock">Stock</option>
          <option value="crypto">Crypto</option>
        </select>
      </Field>
      <Field label="Quantity">
        <input name="quantity" required inputMode="decimal" className={inputClass} placeholder="10" />
      </Field>
      <Field label="Total cost basis (USD)">
        <input name="cost_basis" inputMode="decimal" className={inputClass} placeholder="optional" />
      </Field>
      <div className="sm:col-span-6 flex items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Adding..." : "Add holding"}</Button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}

export function EditHolding({
  holding,
}: {
  holding: { id: string; symbol: string; asset_type: string; quantity: number; cost_basis: number | null };
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(updateHolding, null);
  if (!open) {
    return <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(true)}>Edit</Button>;
  }
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={holding.id} />
      <Field label="Symbol"><input name="symbol" defaultValue={holding.symbol} className={`${inputClass} w-24`} required /></Field>
      <Field label="Type">
        <select name="asset_type" defaultValue={holding.asset_type === "crypto" ? "crypto" : "stock"} className={`${inputClass} w-24`}>
          <option value="stock">Stock</option>
          <option value="crypto">Crypto</option>
        </select>
      </Field>
      <Field label="Qty"><input name="quantity" defaultValue={String(holding.quantity)} className={`${inputClass} w-28`} required /></Field>
      <Field label="Cost basis"><input name="cost_basis" defaultValue={holding.cost_basis ?? ""} className={`${inputClass} w-28`} /></Field>
      <Button type="submit" size="sm" disabled={pending}>Save</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
      <FormStatus state={state} />
    </form>
  );
}
