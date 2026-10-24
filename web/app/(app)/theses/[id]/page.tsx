import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";

async function ThesisHeader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PageHeader title="Thesis" description={`ID: ${id}`} />;
}

export default function ThesisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <>
      <Suspense fallback={<PageHeader title="Thesis" />}>
        <ThesisHeader params={params} />
      </Suspense>
      <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
        Coming soon.
      </div>
    </>
  );
}
