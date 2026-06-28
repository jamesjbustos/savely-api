// Brand matching brain. Shared by the provider crons (auto-match incoming
// offers) and the admin matching endpoints (suggest + bulk auto-match the
// unmatched queue) so scoring is always consistent with how the crons match.
//
// Two tiers, by design:
//   - safeAutoMatch(): provably-safe, no-human matches only (exact normalized
//     key, or one name's tokens are a subset of the other with the only
//     leftover tokens being filler like "store"/"online"). Refuses when more
//     than one brand qualifies — ambiguous goes to review, never guessed.
//   - bestCandidate(): fuzzy best guess (trigram + token overlap) for the
//     one-click ✓ review tier in the admin UI.

/**
 * Normalize a name so "Applebee's", "applebees", and "Apple Bee's" collapse to
 * one key. `&` and `+` both fold to "and" so "Academy Sports + Outdoors" (our
 * brand) and "Academy Sports & Outdoors" (a provider's product) match.
 */
export function normalizeBrandKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics: "Aéropostale" -> "aeropostale"
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[&+]/g, "and") // "&" and "+" both mean "and"
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tokens that don't distinguish one brand from another. A subset match whose
// only leftover tokens are filler is still safe to auto-match. Numbers are
// NEVER filler (a "$25" vs "$50" distinction must block), and distinguishing
// product words (kids, plus, mini, pro, platinum…) are deliberately absent.
const FILLER = new Set([
  "store",
  "shop",
  "online",
  "the",
  "inc",
  "co",
  "llc",
  "ltd",
  "usa",
  "us",
  "official",
  "retail",
  "and",
]);

export function tokenize(key: string): string[] {
  return key ? key.split(" ").filter(Boolean) : [];
}

export interface BrandLite {
  id: string;
  name: string;
  slug: string;
  base_domain?: string | null;
  key: string; // normalizeBrandKey(name)
  tokens: Set<string>;
}

/** Build the lightweight, pre-normalized brand list scoring works against. */
export function buildBrandLite(
  rows: Array<{ id: string; name: string; slug: string; base_domain?: string | null }>,
): BrandLite[] {
  const out: BrandLite[] = [];
  for (const r of rows) {
    const key = normalizeBrandKey(r.name);
    if (!key) continue;
    out.push({
      id: r.id,
      name: r.name,
      slug: r.slug,
      base_domain: r.base_domain ?? null,
      key,
      tokens: new Set(tokenize(key)),
    });
  }
  return out;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

function leftoverAllFiller(superset: Set<string>, subset: Set<string>): boolean {
  for (const t of superset) if (!subset.has(t) && !FILLER.has(t)) return false;
  return true;
}

export interface SafeMatch {
  brandId: string;
  reason: "exact" | "brand-in-product" | "product-in-brand";
}

/**
 * Conservative, precision-first auto-match. Returns a brand id ONLY when it is
 * unambiguous and provably safe; otherwise null (→ leave for human review).
 */
export function safeAutoMatch(productKey: string, brands: BrandLite[]): SafeMatch | null {
  const pk = productKey.trim();
  if (pk.length < 3) return null;
  const pt = new Set(tokenize(pk));
  if (pt.size === 0) return null;
  // Must have at least one distinguishing (non-filler) token, else far too loose.
  const hasCore = [...pt].some((t) => !FILLER.has(t));
  if (!hasCore) return null;

  const exact: SafeMatch[] = [];
  const subset: SafeMatch[] = [];
  for (const b of brands) {
    if (b.tokens.size === 0) continue;
    if (b.key === pk) {
      exact.push({ brandId: b.id, reason: "exact" });
      continue;
    }
    // brand tokens ⊆ product tokens, leftover product tokens all filler
    if (isSubset(b.tokens, pt) && leftoverAllFiller(pt, b.tokens)) {
      subset.push({ brandId: b.id, reason: "brand-in-product" });
      continue;
    }
    // product tokens ⊆ brand tokens, leftover brand tokens all filler
    if (isSubset(pt, b.tokens) && leftoverAllFiller(b.tokens, pt)) {
      subset.push({ brandId: b.id, reason: "product-in-brand" });
    }
  }

  // A single exact key wins outright. Multiple exacts shouldn't happen (the
  // brand index is keyed), but if it does it's ambiguous → bail.
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  // Otherwise only auto-match when exactly one brand qualifies by subset.
  if (subset.length === 1) return subset[0]!;
  return null;
}

// ── Fuzzy scoring for the review tier ────────────────────────────────────

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams (mirrors Postgres pg_trgm). */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface Candidate {
  brand: BrandLite;
  score: number; // 0..1
  reason: string;
}

/**
 * Best fuzzy brand guess for an unmatched key. Returns null below `min` so the
 * UI only suggests something worth a glance.
 */
export function bestCandidate(
  productKey: string,
  brands: BrandLite[],
  min = 0.4,
): Candidate | null {
  const pk = productKey.trim();
  if (!pk) return null;
  const pt = new Set(tokenize(pk));
  let best: Candidate | null = null;
  for (const b of brands) {
    const tri = trigramSimilarity(pk, b.key);
    const jac = jaccard(pt, b.tokens);
    const contained = isSubset(b.tokens, pt) || isSubset(pt, b.tokens);
    const score = Math.min(1, Math.max(tri, jac) + (contained ? 0.1 : 0));
    if (!best || score > best.score) {
      best = { brand: b, score, reason: contained ? "overlap" : "fuzzy" };
    }
  }
  return best && best.score >= min ? best : null;
}
