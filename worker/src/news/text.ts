// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]", "g");

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", lsquo: "'", rsquo: "'",
  ldquo: '"', rdquo: '"', hellip: "...",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return s
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-z!][^>]*>/gi, " ");
}

/** Turn feed HTML into plain text: no tags, no entities, no control chars, collapsed whitespace, clipped. */
export function toPlainText(input: unknown, max = 600): string {
  if (typeof input !== "string") return "";
  let s = stripTags(input);
  s = decodeEntities(s);
  s = stripTags(s); // entity-encoded markup (&lt;b&gt;) is removed too
  s = s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}
