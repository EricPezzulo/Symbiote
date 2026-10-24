import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdminConfigured } from "@/lib/supabase/admin";
import { isEncryptionConfigured } from "@/lib/crypto";
import { isSnaptradeConfigured } from "@/lib/snaptrade/client";
import { syncSnaptrade } from "@/lib/snaptrade/service";

// SnapTrade redirects the browser here after the connection portal. We ignore
// query params (untrusted) and simply sync whatever SnapTrade says is linked.
export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  const dest = (status: string) => NextResponse.redirect(`${origin}/settings/connections?snaptrade=${status}`);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  if (!isSnaptradeConfigured() || !isEncryptionConfigured() || !isAdminConfigured()) return dest("unconfigured");

  try {
    await syncSnaptrade(supabase, user.id);
    return dest("connected");
  } catch {
    return dest("error");
  }
}
