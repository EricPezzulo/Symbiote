import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Nav } from "@/components/nav";
import { signOut } from "@/app/auth/actions";
import { createClient } from "@/lib/supabase/server";

async function UserEmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return (
    <p className="truncate px-3 text-xs text-muted-foreground">{user?.email}</p>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <aside className="flex flex-col gap-4 border-b p-3 md:w-56 md:border-r md:border-b-0 md:p-4">
        <div className="px-3 text-lg font-semibold tracking-tight">Symbiote</div>
        <Suspense fallback={null}>
          <Nav />
        </Suspense>
        <div className="mt-auto space-y-2">
          <Suspense fallback={null}>
            <UserEmail />
          </Suspense>
          <form action={signOut}>
            <Button variant="outline" size="sm" className="w-full">
              Sign out
            </Button>
          </form>
        </div>
      </aside>
      <main className="flex-1 p-6 md:p-8">{children}</main>
    </div>
  );
}
