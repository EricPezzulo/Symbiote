import { XMLParser } from "fast-xml-parser";
import { toPlainText } from "./text.js";

export type FeedEntry = {
  id: string | null;
  title: string;
  link: string | null;
  summary: string;
  published: string | null;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

const text = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Record<string, unknown>)["#text"]);
  return "";
};

function atomLink(links: unknown): string | null {
  const arr = Array.isArray(links) ? links : links ? [links] : [];
  let fallback: string | null = null;
  for (const l of arr) {
    if (typeof l === "string") return l;
    const o = l as Record<string, unknown>;
    const href = typeof o["@_href"] === "string" ? (o["@_href"] as string) : null;
    if (!href) continue;
    const rel = o["@_rel"];
    if (!rel || rel === "alternate") return href;
    fallback ??= href;
  }
  return fallback;
}

/**
 * Parse RSS 2.0 / RSS 1.0-ish / Atom into plain entries (HTML stripped, never fetches linked pages).
 * Throws on non-feed XML. Rejects documents that declare entities (XXE / entity-expansion hardening).
 */
export function parseFeed(xml: string, maxSummary = 600): FeedEntry[] {
  if (/<!ENTITY/i.test(xml)) throw new Error("feed declares XML entities; refusing to parse");
  const doc = parser.parse(xml.replace(/^﻿/, "")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: FeedEntry[] = [];
  const rssItems: any[] | undefined = doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (rssItems) {
    for (const it of rssItems) {
      const link = text(it.link) || (typeof it.guid === "string" && /^https?:/i.test(it.guid) ? it.guid : text(it.guid?.["#text"]));
      out.push({
        id: text(it.guid) || null,
        title: toPlainText(text(it.title), 300),
        link: link || null,
        summary: toPlainText(text(it.description) || text(it["content:encoded"]), maxSummary),
        published: text(it.pubDate) || text(it["dc:date"]) || null,
      });
    }
    return out;
  }
  const entries: any[] | undefined = doc.feed?.entry; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (entries) {
    for (const e of entries) {
      out.push({
        id: text(e.id) || null,
        title: toPlainText(text(e.title), 300),
        link: atomLink(e.link),
        summary: toPlainText(text(e.summary) || text(e.content), maxSummary),
        published: text(e.published) || text(e.updated) || null,
      });
    }
    return out;
  }
  if (doc.rss?.channel || doc.feed) return []; // valid but empty
  throw new Error("not an RSS or Atom document");
}
