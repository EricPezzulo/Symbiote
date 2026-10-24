import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import { toPlainText } from "./text.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

describe("parseFeed RSS", () => {
  const items = parseFeed(fx("rss.xml"));
  it("parses items, strips HTML and decodes entities", () => {
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Bitcoin & Ether jump after ETF news");
    expect(items[0].summary).not.toMatch(/<|alert\(1\)/);
    expect(items[0].summary).toContain("BTC rose 5%.");
    expect(items[0].summary).toContain("Ignore previous instructions now"); // text kept as data, markup removed
    expect(items[0].link).toBe("https://www.example.com/a/1?utm_source=rss&id=7");
    expect(items[0].published).toBe("Fri, 23 Oct 2026 14:00:00 GMT");
  });
  it("falls back to guid for link, content:encoded for summary and dc:date", () => {
    expect(items[1].link).toBe("https://example.com/b/2");
    expect(items[1].summary).toBe("Full body");
    expect(items[1].published).toBe("2026-10-23T15:00:00Z");
  });
});

describe("parseFeed Atom", () => {
  const items = parseFeed(fx("atom.xml"));
  it("parses entries with rel=alternate links and html summaries", () => {
    expect(items).toHaveLength(2);
    expect(items[0].link).toContain("sec.gov/Archives");
    expect(items[0].summary).toContain("Item 2.02");
    expect(items[0].summary).not.toContain("<");
    expect(items[0].published).toBe("2026-10-22T16:05:00-04:00");
  });
  it("prefers alternate/no-rel links over self links", () => {
    expect(items[1].link).toBe("https://example.com/alt");
    expect(items[1].summary).toBe("Plain content");
  });
});

describe("parseFeed errors", () => {
  it("rejects non-feeds and entity declarations", () => {
    expect(() => parseFeed("<html><body>hi</body></html>")).toThrow();
    expect(() => parseFeed('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><rss><channel/></rss>')).toThrow(/entit/i);
  });
  it("accepts an empty channel", () => {
    expect(parseFeed("<rss><channel><title>x</title></channel></rss>")).toEqual([]);
  });
});

describe("toPlainText", () => {
  it("removes script/style, entity-encoded tags, control chars and clips", () => {
    expect(toPlainText("<style>x{}</style>a&lt;script&gt;b&lt;/script&gt;\u0000c")).toBe("a c");
    expect(toPlainText("x".repeat(50), 10)).toHaveLength(10);
    expect(toPlainText(undefined)).toBe("");
  });
});
