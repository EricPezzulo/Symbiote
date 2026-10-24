"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-runs the server components on an interval (paused while the tab is hidden). Realtime is not needed for news. */
export function IntervalRefresh({ everyMs = 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
