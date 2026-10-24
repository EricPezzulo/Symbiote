"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { newer, PRICE_COLUMNS, toPriceRow, type PriceRow } from "./types";

export type LiveStatus = "connecting" | "live" | "reconnecting";
export type Flash = "up" | "down";

/** Subscribe to Realtime changes on `prices` for `symbols`. Server-fetched `initial` rows seed the table. */
export function useLivePrices(initial: PriceRow[], symbols: string[], opts: { flashMs?: number } = {}) {
  const [live, setLive] = useState<Map<string, PriceRow>>(new Map());
  const [flash, setFlash] = useState<Record<string, Flash>>({});
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const known = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flashMs = opts.flashMs ?? 900;
  const key = useMemo(() => [...new Set(symbols)].sort().join(","), [symbols]);

  // Server-provided rows win only if they are newer than what Realtime delivered.
  const rows = useMemo(() => {
    const m = new Map<string, PriceRow>();
    for (const r of initial) m.set(r.symbol, r);
    for (const [s, r] of live) {
      const merged = newer(m.get(s), r);
      if (merged) m.set(s, merged);
    }
    return m;
  }, [initial, live]);

  useEffect(() => {
    for (const r of initial) if (!known.current.has(r.symbol)) known.current.set(r.symbol, r.price);
  }, [initial]);

  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (list.length === 0) return;
    const supabase = createClient();
    const wanted = new Set(list);
    let cancelled = false;

    const apply = (raw: Record<string, unknown> | null | undefined) => {
      const row = toPriceRow(raw);
      if (!row || !wanted.has(row.symbol)) return;
      setLastEventAt(Date.now());
      setLive((prev) => {
        const next = new Map(prev);
        next.set(row.symbol, newer(prev.get(row.symbol), row) ?? row);
        return next;
      });
      const before = known.current.get(row.symbol);
      known.current.set(row.symbol, row.price);
      if (before !== undefined && before !== row.price) {
        setFlash((f) => ({ ...f, [row.symbol]: row.price > before ? "up" : "down" }));
        const old = timers.current.get(row.symbol);
        if (old) clearTimeout(old);
        timers.current.set(
          row.symbol,
          setTimeout(() => {
            setFlash((f) => {
              const { [row.symbol]: _drop, ...rest } = f;
              void _drop;
              return rest;
            });
          }, flashMs),
        );
      }
    };

    // Re-read after (re)connecting so a gap in the stream never leaves stale numbers.
    const resync = async () => {
      const { data } = await supabase.from("prices").select(PRICE_COLUMNS).in("symbol", list);
      if (cancelled) return;
      for (const r of (data ?? []) as Record<string, unknown>[]) apply(r);
    };

    // PostgREST "in" filter in Realtime supports up to 100 values; beyond that filter client-side.
    const filter = list.length <= 100 ? `symbol=in.(${list.join(",")})` : undefined;
    const channel = supabase
      .channel(`prices-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "prices", ...(filter ? { filter } : {}) },
        (payload) => apply(payload.new as Record<string, unknown>),
      )
      .subscribe((s) => {
        if (cancelled) return;
        if (s === "SUBSCRIBED") {
          setStatus("live");
          void resync();
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          setStatus("reconnecting");
        }
      });

    const pending = timers.current;
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, [key, flashMs]);

  return { rows, flash, status, lastEventAt };
}

/** Re-renders every `ms` with the current time; null until mounted (avoids hydration mismatch). */
export function useNow(ms = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, ms);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [ms]);
  return now;
}
