"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { errState, okState, requireUser, type ActionState } from "@/lib/auth";
import { firstError } from "@/lib/holdings/schemas";
import { watchAddSchema, watchUpdateSchema } from "@/lib/watchlist/schemas";

const form = (fd: FormData) => Object.fromEntries(fd) as Record<string, string>;
const refresh = () => revalidatePath("/watchlist");

export async function addWatch(_prev: ActionState | null, fd: FormData): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const parsed = watchAddSchema.safeParse(form(fd));
  if (!parsed.success) return errState(firstError(parsed.error));
  const { error } = await supabase.from("watchlist").insert({ ...parsed.data, user_id: user.id });
  if (error) {
    if (error.code === "23505") return errState(`${parsed.data.symbol} is already on your watchlist.`);
    // 42703 = undefined column: the Phase 3 migration has not been pushed yet.
    if (error.code === "42703" || error.code === "PGRST204") return errState("Watchlist alerts need the latest migration (run `npx supabase db push`).");
    return errState("Could not add symbol.");
  }
  refresh();
  return okState(`Added ${parsed.data.symbol}`);
}

export async function updateWatch(_prev: ActionState | null, fd: FormData): Promise<ActionState> {
  const { supabase, user } = await requireUser();
  const parsed = watchUpdateSchema.safeParse(form(fd));
  if (!parsed.success) return errState(firstError(parsed.error));
  const { id, ...fields } = parsed.data;
  const { data: existing } = await supabase
    .from("watchlist")
    .select("alert_above,alert_below")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!existing) return errState("Watchlist entry not found.");
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  // A changed target re-arms the worker alert for that side.
  const rearm = {
    ...(num(existing.alert_above) !== fields.alert_above ? { alert_above_fired_at: null } : {}),
    ...(num(existing.alert_below) !== fields.alert_below ? { alert_below_fired_at: null } : {}),
  };
  const { error } = await supabase.from("watchlist").update({ ...fields, ...rearm }).eq("id", id).eq("user_id", user.id);
  if (error) return errState("Could not save changes.");
  refresh();
  return okState("Saved");
}

export async function removeWatch(fd: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return;
  await supabase.from("watchlist").delete().eq("id", id.data).eq("user_id", user.id);
  refresh();
}
