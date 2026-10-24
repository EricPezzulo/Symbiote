// US equity regular session hint. Does NOT model exchange holidays or early closes.

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

export function usMarketOpen(at: Date = new Date()): boolean {
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function marketHint(at: Date = new Date()): string {
  return usMarketOpen(at)
    ? "US market open (9:30-16:00 ET)"
    : "US market closed: stock prices show the last trade; crypto trades 24/7";
}
