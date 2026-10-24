"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";

const idSchema = z.uuid();
const refresh = () => {
  revalidatePath("/news");
  revalidatePath("/");
};

/** All three actions authenticate, then run through the user's RLS-scoped client AND filter by user_id / kind. */
export async function markRead(fd: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = idSchema.safeParse(fd.get("id"));
  if (!id.success) return;
  await supabase.from("alerts").update({ read_at: new Date().toISOString() }).eq("id", id.data).eq("user_id", user.id).eq("kind", "news").is("read_at", null);
  refresh();
}

export async function markAllRead(): Promise<void> {
  const { supabase, user } = await requireUser();
  await supabase.from("alerts").update({ read_at: new Date().toISOString() }).eq("user_id", user.id).eq("kind", "news").is("read_at", null);
  refresh();
}

export async function dismiss(fd: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  const id = idSchema.safeParse(fd.get("id"));
  if (!id.success) return;
  const now = new Date().toISOString();
  await supabase.from("alerts").update({ dismissed_at: now, read_at: now }).eq("id", id.data).eq("user_id", user.id).eq("kind", "news");
  refresh();
}
