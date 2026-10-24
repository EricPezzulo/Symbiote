import { Suspense } from "react";
import { SignInButton } from "./sign-in-button";

async function LoginError({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!error) return null;
  return (
    <p className="text-sm text-destructive">Sign-in failed. Please try again.</p>
  );
}

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Symbiote</h1>
          <p className="text-sm text-muted-foreground">
            Your portfolio, news, and theses in one place.
          </p>
        </div>
        <SignInButton />
        <Suspense fallback={null}>
          <LoginError searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
