"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Keeps server-rendered valuation views live: on any `prices` change for the given symbols (or on a
 * fallback interval if Realtime is unavailable) it calls router.refresh(), at most once per `minGapMs`.
 */
export function LiveRefresh({ symbols, minGapMs = 5000, fallbackMs = 60000 }: { symbols: string[]; minGapMs?: number; fallbackMs?: number }) {
  const router = useRouter();
  const key = [...new Set(symbols)].sort().join(",");
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    const wanted = new Set(list);
    const refresh = () => {
      const wait = last.current + minGapMs - Date.now();
      if (wait > 0) {
        if (!timer.current) {
          timer.current = setTimeout(() => {
            timer.current = null;
            refresh();
          }, wait);
        }
        return;
      }
      last.current = Date.now();
      router.refresh();
    };
    const supabase = createClient();
    const channel = supabase
      .channel(`live-refresh-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "prices", ...(list.length <= 100 ? { filter: `symbol=in.(${list.join(",")})` } : {}) }, (p) => {
        const sym = (p.new as { symbol?: string } | null)?.symbol;
        if (!sym || wanted.has(sym)) refresh();
      })
      .subscribe();
    const poll = setInterval(refresh, fallbackMs);
    return () => {
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      void supabase.removeChannel(channel);
    };
  }, [key, minGapMs, fallbackMs, router]);

  return null;
}
