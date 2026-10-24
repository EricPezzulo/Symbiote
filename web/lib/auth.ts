import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Verified user (revalidated with Supabase) + an RLS-scoped client. Throws if signed out. */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  return { supabase, user };
}

export type ActionState = { ok: boolean; message?: string; error?: string };
export const okState = (message?: string): ActionState => ({ ok: true, message });
export const errState = (error: string): ActionState => ({ ok: false, error });
