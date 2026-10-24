import { createHash } from "node:crypto";

const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|cmpid|ocid|taid|guccounter|yptr|ref|ref_src|rss|source|campaign|cid|sref|smid|st|share|__twitter_impression)$/i;

/** Only http/https URLs are accepted; returns null otherwise. */
export function canonicalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password) return null;
  u.protocol = "https:";
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (u.port === "443" || u.port === "80") u.port = "";
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.toString();
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Hash of the canonical URL, ignoring a leading "www." so mirrors collapse. */
export function urlHash(canonical: string): string {
  return sha(canonical.replace(/^https:\/\/www\./, "https://"));
}

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function titleHash(title: string): string {
  return sha(normalizeTitle(title));
}
