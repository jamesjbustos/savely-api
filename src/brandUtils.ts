/**
 * Coerce whatever an admin types into a clean, bare host for `base_domain`
 * (and other domain fields). Keeps any "www." (some hosts need it to resolve),
 * but strips protocols — including malformed/duplicated ones like
 * "https://https//www.x.com" — plus paths, queries, and trailing slashes.
 * Returns null for empty input.
 */
export function sanitizeDomain(input: unknown): string | null {
  if (input == null) return null;
  let d = String(input).trim().toLowerCase();
  if (!d) return null;
  // Strip one or more leading protocols, tolerating a missing colon ("https//").
  d = d.replace(/^(https?:?\/\/+)+/g, "");
  // Strip any path / query / hash, then stray leading dots and whitespace.
  d = d.replace(/[/?#].*$/, "").replace(/^\.+/, "").trim();
  return d || null;
}

export function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (m, p1, p2) => `${p1}${p2.toUpperCase()}`);
}

export function normalizeBrandName(rawName: string): string {
  if (!rawName || typeof rawName !== "string") return "";
  let name = rawName.normalize("NFKC").trim();
  name = name.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[®™]/g, "");
  {
    const rawLower = rawName.toLowerCase();
    if (/\bxbox\s+prepaid\b/.test(rawLower)) return "Xbox";
    if (/\bxbox\s+game\s+pass\b/.test(rawLower)) return "Xbox Game Pass";
  }
  name = name.replace(/\bpowered\s+by\s+.+$/i, " ").trim();
  name = name.replace(/\([^)]*\)/g, " ").trim();
  name = name.replace(/\.com\b/gi, " ").trim();
  const noisePatterns = [
    /\b(in[\s-]?store\s+only)\b/gi,
    /\bonline\s+only\b/gi,
    /\b(app\s+only)\b/gi,
    /\b(merchandise\s+credit)\b/gi,
    /\b(e[\s-]?gift(?:\s+card)?)\b/gi,
    /\b(physical\s+cards?)\b/gi,
    /\bgift\s*cards?\b/gi,
    /\binstant\s+delivery\b/gi,
  ];
  for (const pat of noisePatterns) name = name.replace(pat, " ");
  name = name.replace(/\s+/g, " ").trim();
  name = name.replace(
    /^(\d+)[\s-]+(\d+)\b[\s-]*/i,
    (_m, g1, g2) => `${g1}-${g2}-`
  );
  name = name.replace(/^(\d+-\d+)-$/, "$1");
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (
    letters &&
    (letters === letters.toUpperCase() || letters === letters.toLowerCase())
  ) {
    name = toTitleCase(name);
  }
  name = name
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  name = name.replace(/^-+|-+$/g, "");
  return name;
}

export function slugifyBrandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

export function mapVariantFromStrings(
  name: string,
  title: string
): "online" | "in_store" | "other" {
  const n = String(name || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  if (
    /\bin[\s-]?store\b/.test(n) ||
    /\bphysical\b/.test(n) ||
    /\bin[\s-]?store\b/.test(t)
  )
    return "in_store";
  if (
    /\bonline\s+only\b/.test(n) ||
    /\be[\s-]?gift\b/.test(n) ||
    /\bapp\s+only\b/.test(n)
  )
    return "online";
  if (/\bonline\s+only\b/.test(t)) return "online";
  return "other";
}


