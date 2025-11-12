// src/ingest/util.ts

export function decodeHtml(s: string) {
  if (!s) return s;
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
    String.fromCodePoint(parseInt(h, 16))
  );
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  return s;
}

export function fetchText(url: string) {
  return fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "text/html",
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`Fetch ${r.status} ${url}`);
    return r.text();
  });
}

export function extractXmlLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

export function getH1(html: string) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]*>/g, "").trim() : "";
}

export function looksLike404(html: string) {
  const h1 = decodeHtml(getH1(html)).toLowerCase();
  return h1.includes("sorry") && h1.includes("find");
}

// Clean “Discounted Domino's Pizza Cards”
export function cleanBrand(raw: string) {
  let s = decodeHtml(raw).replace(/[®™]/g, "").trim();
  s = s
    .replace(/^discounted\s+/i, "")
    .replace(/\bgift\s*card(s)?\b/gi, "")
    .replace(/\bcards\b/gi, "")
    .replace(/\bonline only\b/gi, "")
    .replace(/\bin store only\b/gi, "")
    .trim();

  const acr = new Set(["CVS", "AMC", "IHOP", "REI", "ULTA"]);
  s = s
    .split(" ")
    .map((w) => {
      const up = w.toUpperCase();
      return acr.has(up) ? up : w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");

  return s;
}

export function toSlug(name: string) {
  return decodeHtml(name)
    .replace(/[®™]/g, "")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

// Canonicalization helpers for brand names
const KEEP_DOTCOM = new Set([
  "WINE.COM",
  "HOTELS.COM",
  "MOVIETICKETS.COM",
  "NFLSHOP.COM",
  "ZAPPOS.COM",
]);

export function normalizeBrandCore(raw: string) {
  // Decode/trim early
  let s = decodeHtml(raw).trim();

  // Strip ®/™ and extra markup words
  s = s
    .replace(/[®™]/g, "")
    .replace(/\bgift\s*card(s)?\b/gi, "")
    .replace(/\bcards\b/gi, "")
    .replace(/\bonline only\b/gi, "")
    .replace(/\bin store only\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Handle & → and (improves slug stability across providers)
  s = s.replace(/&/g, " and ");

  // If it ends with ".com" but isn't a canonical dot-com brand, drop it
  const upper = s.toUpperCase().replace(/\s+/g, "");
  if (/\.\s*com$/i.test(s) && !KEEP_DOTCOM.has(upper)) {
    s = s.replace(/\.\s*com$/i, "");
  }

  // Title-case w/ simple acronym pass
  const acr = new Set([
    "CVS",
    "AMC",
    "IHOP",
    "REI",
    "ULTA",
    "NFL",
    "MLB",
    "NBA",
  ]);
  s = s
    .split(/\s+/)
    .map((w) => {
      const up = w.toUpperCase();
      return acr.has(up) ? up : w[0]?.toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");

  return s.trim();
}

export function canonicalizeBrandName(raw: string) {
  return normalizeBrandCore(raw);
}

export function extractPercent(html: string): number | null {
  const m =
    html.match(/Up\s*to[^%]{0,50}?(\d{1,2}(?:\.\d)?)\s*%/i) ||
    html.match(/(\d{1,2}(?:\.\d)?)\s*%/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isNaN(n) ? null : n;
}

// util.ts
export function detectVariantFromUrl(
  url: string
): "online" | "in_store_only" | "other" {
  if (/\/discount-.*-in-store-only-cards\/?$/i.test(url))
    return "in_store_only";
  if (/\/discount-.*-cards\/?$/i.test(url)) return "online";
  return "other";
}
