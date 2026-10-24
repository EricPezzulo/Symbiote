"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { errState, okState, requireUser, type ActionState } from "@/lib/auth";
import { accountSchema, firstError, holdingSchema, holdingUpdateSchema } from "@/lib/holdings/schemas";

function refresh() {
  revalidatePath("/holdings");
  revalidatePath("/");
}

const form = (fd: FormData) => Object.fromEntries(fd) as Record<string, string>;

export async function createAccount(_prev: ActionState | null, fd: FormData): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const parsed = accountSchema.safeParse(form(fd));
  if (!parsed.success) return errState(firstError(parsed.error));
  const { error } = await supabase.from("accounts").insert({ ...parsed.data, user_id: user.id });
  if (error) return errState("Could not create account.");
  refresh();
  return okState("Account created");
}

export async function deleteAccount(fd: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return;
  // Holdings cascade. Wallet-backed accounts are managed from Connections.
  await supabase.from("accounts").delete().eq("id", id.data).eq("user_id", user.id).is("wallet_id", null);
  refresh();
}

export async function createHolding(_prev: ActionState | null, fd: FormData): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const parsed = holdingSchema.safeParse(form(fd));
  if (!parsed.success) return errState(firstError(parsed.error));
  const { error } = await supabase
    .from("holdings")
    .insert({ ...parsed.data, user_id: user.id, source: "manual" });
  if (error) {
    return errState(
      error.code === "23505"
        ? `${parsed.data.symbol} already exists in that account. Edit the existing row instead.`
        : "Could not add holding (is the account yours?).",
    );
  }
  refresh();
  return okState(`Added ${parsed.data.symbol}`);
}

export async function updateHolding(_prev: ActionState | null, fd: FormData): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const parsed = holdingUpdateSchema.safeParse(form(fd));
  if (!parsed.success) return errState(firstError(parsed.error));
  const { id, ...fields } = parsed.data;
  // Only manual rows are editable; synced rows would be overwritten on the next sync.
  const { data, error } = await supabase
    .from("holdings")
    .update(fields)
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("source", "manual")
    .select("id");
  if (error) {
    return errState(error.code === "23505" ? "That symbol already exists in this account." : "Could not update holding.");
  }
  if (!data?.length) return errState("Only manually entered holdings can be edited.");
  refresh();
  return okState("Saved");
}

export async function deleteHolding(fd: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return;
  await supabase.from("holdings").delete().eq("id", id.data).eq("user_id", user.id);
  refresh();
}
