import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolvePath(__filename, "..");

// --- Env / config helpers ---------------------------------------------------

function loadDevVarsIfPresent() {
  const devVarsPath = resolvePath(process.cwd(), ".dev.vars");
  try {
    const raw = readFileSync(devVarsPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore if missing
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    limit: 50,
    brandSlugs: [],
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--no-dry-run") {
      args.dryRun = false;
    } else if (arg.startsWith("--limit=")) {
      const v = Number(arg.slice("--limit=".length));
      if (Number.isFinite(v) && v > 0) args.limit = Math.floor(v);
    } else if (arg === "--limit") {
      const next = argv[i + 1];
      const v = Number(next);
      if (Number.isFinite(v) && v > 0) {
        args.limit = Math.floor(v);
        i++;
      }
    } else if (arg.startsWith("--brand-slugs=")) {
      const list = arg.slice("--brand-slugs=".length);
      args.brandSlugs = list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--brand-slugs") {
      const next = argv[i + 1];
      if (next) {
        args.brandSlugs = next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i++;
      }
    }
  }

  return args;
}

// --- Text / scoring helpers -------------------------------------------------

const HOST_DENYLIST = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "pinterest.com",
  "yelp.com",
  "tripadvisor.com",
  "wikipedia.org",
  "wiktionary.org",
  "fandom.com",
  "reddit.com",
  "glassdoor.com",
  "indeed.com",
  "yahoo.com",
  "bing.com",
  "google.com",
  "nytimes.com",
];

// Subdomains that usually indicate jobs/support/locations rather than the primary shop
const UTILITY_SUBDOMAIN_PREFIXES = [
  "jobs",
  "careers",
  "career",
  "support",
  "help",
  "service",
  "services",
  "locations",
  "location",
  "locator",
  "checkcoverage",
  "news",
  "stores",
  "blog",
  "storelocator",
  "storelocations",
];

const NEGATIVE_TITLE_TERMS = [
  "review",
  "reviews",
  "coupon",
  "coupons",
  "promo",
  "discount",
  "discounts",
  "code",
  "codes",
  "deal",
  "deals",
  "price",
  "prices",
];

const BRAND_STOPWORDS = new Set([
  "the",
  "and",
  "kids",
  "kid",
  "baby",
  "store",
  "stores",
  "shop",
  "shops",
  "factory",
  "outlet",
  "outlets",
  "company",
  "co",
  "inc",
  "llc",
  "ltd",
  "online",
  "official",
  "cards",
  "card",
]);

function normalizeWhitespace(str) {
  return String(str || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function getBrandRootToken(brandName) {
  const name = normalizeWhitespace(brandName).toLowerCase();
  if (!name) return null;
  const tokens = name
    .replace(/[®™]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const t of tokens) {
    if (!BRAND_STOPWORDS.has(t)) return t;
  }
  return tokens[0] || null;
}

function extractHostname(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeHostnameForStorage(hostname) {
  if (!hostname) return null;
  let h = hostname.toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  // strip trailing dot if present
  if (h.endsWith(".")) h = h.slice(0, -1);
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const firstLabel = parts[0];
  const isUtility = UTILITY_SUBDOMAIN_PREFIXES.some((p) => {
    if (firstLabel === p) return true;
    if (firstLabel.startsWith(`${p}-`)) return true;
    if (firstLabel.endsWith(`-${p}`)) return true;
    return false;
  });
  // Collapse obvious utility subdomains (jobs., careers., help., support., locations.) to the registrable domain
  if (isUtility) {
    return parts.slice(-2).join(".");
  }
  // Keep other subdomains (e.g. store.steampowered.com) as-is
  return h;
}

function getDomainRoot(hostname) {
  if (!hostname) return null;
  const h = hostname.toLowerCase();
  const parts = h.split(".");
  if (parts.length <= 2) return parts[0] || null;
  return parts[parts.length - 2] || null;
}

function isJunkHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return HOST_DENYLIST.some(
    (pattern) => h === pattern || h.endsWith(`.${pattern}`)
  );
}

function scoreCandidate({ brandName, hostname, title, googleRank }) {
  const brandRoot = getBrandRootToken(brandName);
  const domainRoot = getDomainRoot(hostname);
  const fullBrandLower = normalizeWhitespace(brandName).toLowerCase();
  const titleLower = normalizeWhitespace(title).toLowerCase();

  let score = 0.0;

  if (brandRoot && domainRoot) {
    if (brandRoot === domainRoot) {
      score = 0.9;
    } else if (
      domainRoot.includes(brandRoot) ||
      brandRoot.includes(domainRoot)
    ) {
      score = 0.75;
    } else if (fullBrandLower.includes(domainRoot)) {
      score = 0.65;
    } else {
      score = 0.4;
    }
  } else {
    score = 0.3;
  }

  if (Number.isFinite(googleRank)) {
    const r = Math.max(1, Math.min(googleRank, 5));
    const rankBonus = Math.max(0, 0.18 - 0.04 * (r - 1));
    score += rankBonus;
  }

  if (fullBrandLower && titleLower.includes(fullBrandLower)) {
    score += 0.07;
  } else if (brandRoot && titleLower.includes(brandRoot)) {
    score += 0.05;
  }
  if (titleLower.includes("official")) score += 0.05;
  if (titleLower.includes("store") || titleLower.includes("shop"))
    score += 0.03;

  for (const term of NEGATIVE_TITLE_TERMS) {
    if (titleLower.includes(term)) {
      score -= 0.25;
      break;
    }
  }

  if (isJunkHost(hostname)) {
    score -= 0.4;
  }

  if (!Number.isFinite(score)) score = 0;
  if (score < 0) score = 0;
  if (score > 1) score = 1;
  return score;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Google Custom Search ---------------------------------------------------

async function fetchGoogleResults({ apiKey, cx, query }) {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", "5");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Google Custom Search error ${res.status}: ${res.statusText} - ${text}`
    );
  }
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((item, idx) => ({
    link: item.link || item.formattedUrl || "",
    title: item.title || "",
    snippet: item.snippet || "",
    rank: idx + 1,
  }));
}

// --- Main domain resolution per brand --------------------------------------

async function resolveDomainForBrand({
  sql,
  brand,
  apiKey,
  cx,
  dryRun,
  reviewRows,
  failureRows,
}) {
  const brandId = brand.id;
  const brandName = brand.name;
  const brandSlug = brand.slug;

  const query = `${brandName} official site`;

  let results;
  try {
    results = await fetchGoogleResults({ apiKey, cx, query });
  } catch (err) {
    console.error(
      `Failed Google search for brand ${brandSlug} (${brandId}):`,
      err.message
    );
    failureRows.push({
      brand_id: brandId,
      brand_name: brandName,
      brand_slug: brandSlug,
      reason: `google_error: ${err.message}`,
    });
    await sql/* sql */ `
      insert into brand_domain_failures (brand_id, reason)
      values (${brandId}, ${`google_error: ${err.message}`})
      on conflict (brand_id)
      do update set
        reason = excluded.reason,
        last_attempt_at = now(),
        attempts = brand_domain_failures.attempts + 1
    `;
    return { outcome: "failure" };
  }

  if (!results.length) {
    const reason = "no_results";
    failureRows.push({
      brand_id: brandId,
      brand_name: brandName,
      brand_slug: brandSlug,
      reason,
    });
    await sql/* sql */ `
      insert into brand_domain_failures (brand_id, reason)
      values (${brandId}, ${reason})
      on conflict (brand_id)
      do update set
        reason = excluded.reason,
        last_attempt_at = now(),
        attempts = brand_domain_failures.attempts + 1
    `;
    return { outcome: "failure" };
  }

  const candidateMap = new Map();

  for (const r of results) {
    const hostnameRaw = extractHostname(r.link);
    if (!hostnameRaw) continue;
    const storageHost = normalizeHostnameForStorage(hostnameRaw);
    if (!storageHost) continue;
    // Completely ignore social/review/info hosts so they never show up
    // in candidates or influence scoring.
    if (isJunkHost(storageHost)) {
      continue;
    }
    const score = scoreCandidate({
      brandName,
      hostname: storageHost,
      title: r.title || r.snippet || "",
      googleRank: r.rank,
    });

    if (!candidateMap.has(storageHost)) {
      candidateMap.set(storageHost, {
        domain: storageHost,
        bestScore: score,
        bestRank: r.rank,
        bestTitle: r.title || "",
        rawUrl: r.link,
        isJunk: false,
        count: 1,
      });
    } else {
      const c = candidateMap.get(storageHost);
      c.count += 1;
      if (score > c.bestScore) {
        c.bestScore = score;
        c.bestRank = r.rank;
        c.bestTitle = r.title || "";
        c.rawUrl = r.link;
      }
      // remains non-junk; any junk hosts were skipped above
    }
  }

  if (!candidateMap.size) {
    const reason = "no_valid_hostnames";
    failureRows.push({
      brand_id: brandId,
      brand_name: brandName,
      brand_slug: brandSlug,
      reason,
    });
    await sql/* sql */ `
      insert into brand_domain_failures (brand_id, reason)
      values (${brandId}, ${reason})
      on conflict (brand_id)
      do update set
        reason = excluded.reason,
        last_attempt_at = now(),
        attempts = brand_domain_failures.attempts + 1
    `;
    return { outcome: "failure" };
  }

  const candidates = [];
  for (const c of candidateMap.values()) {
    const freqBonus = Math.min(0.1, 0.03 * (c.count - 1));
    const finalScore = Math.max(0, Math.min(1, c.bestScore + freqBonus));
    candidates.push({
      domain: c.domain,
      score: finalScore,
      rank: c.bestRank,
      title: c.bestTitle,
      rawUrl: c.rawUrl,
      isJunk: c.isJunk,
    });
  }

  for (const c of candidates) {
    await sql/* sql */ `
      insert into brand_domain_candidates
        (brand_id, candidate_domain, score, google_rank, title, raw_url, is_filtered)
      values
        (${brandId}, ${c.domain}, ${c.score}, ${c.rank}, ${c.title}, ${c.rawUrl}, ${c.isJunk})
      on conflict (brand_id, candidate_domain)
      do update set
        score = excluded.score,
        google_rank = excluded.google_rank,
        title = excluded.title,
        raw_url = excluded.raw_url,
        is_filtered = excluded.is_filtered
    `;
  }

  const nonJunk = candidates.filter((c) => !c.isJunk);
  if (!nonJunk.length) {
    const reason = "only_junk_hosts";
    failureRows.push({
      brand_id: brandId,
      brand_name: brandName,
      brand_slug: brandSlug,
      reason,
    });
    await sql/* sql */ `
      insert into brand_domain_failures (brand_id, reason)
      values (${brandId}, ${reason})
      on conflict (brand_id)
      do update set
        reason = excluded.reason,
        last_attempt_at = now(),
        attempts = brand_domain_failures.attempts + 1
    `;
    return { outcome: "failure" };
  }

  nonJunk.sort((a, b) => b.score - a.score);
  const best = nonJunk[0];
  const second = nonJunk[1] || null;

  const bestScore = best.score;
  const secondScore = second ? second.score : null;

  const HIGH_THRESHOLD = 0.9;
  const REVIEW_THRESHOLD = 0.6;

  let outcome = "failure";

  const autoAccept =
    bestScore >= HIGH_THRESHOLD &&
    (secondScore == null || bestScore - secondScore >= 0.1);

  if (autoAccept) {
    outcome = "auto_accept";
    if (!dryRun) {
      await sql/* sql */ `
        update brands
        set base_domain = ${best.domain}, updated_at = now()
        where id = ${brandId}
      `;
    }
  } else if (bestScore >= REVIEW_THRESHOLD) {
    outcome = "review";
    const status = "pending";
    await sql/* sql */ `
      insert into brand_domain_reviews
        (brand_id, chosen_domain, score, status)
      values
        (${brandId}, ${best.domain}, ${best.score}, ${status})
      on conflict (brand_id)
      do update set
        chosen_domain = excluded.chosen_domain,
        score = excluded.score,
        status = 'pending',
        reviewer_notes = null,
        reviewed_at = null
    `;
    reviewRows.push({
      brand_id: brandId,
      brand_name: brandName,
      brand_slug: brandSlug,
      chosen_domain: best.domain,
      score: best.score,
      second_best_domain: second ? second.domain : "",
      second_best_score: secondScore ?? "",
    });
  } else {
    outcome = "failure";
    const reason = `low_confidence_best=${bestScore.toFixed(3)}`;
    failureRows.push({
      brand_id: brandId,
      brand_name: brandName,
      brand_slug: brandSlug,
      reason,
    });
    await sql/* sql */ `
      insert into brand_domain_failures (brand_id, reason)
      values (${brandId}, ${reason})
      on conflict (brand_id)
      do update set
        reason = excluded.reason,
        last_attempt_at = now(),
        attempts = brand_domain_failures.attempts + 1
    `;
  }

  return {
    outcome,
    bestDomain: best.domain,
    bestScore,
    secondScore,
  };
}

// --- CSV helpers ------------------------------------------------------------

function toCsvRow(fields) {
  return fields
    .map((v) => {
      if (v == null) return "";
      const s = String(v);
      if (/[",\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(",");
}

function writeCsv(path, headers, rows) {
  const lines = [];
  lines.push(toCsvRow(headers));
  for (const row of rows) {
    const ordered = headers.map((h) =>
      Object.prototype.hasOwnProperty.call(row, h) ? row[h] : ""
    );
    lines.push(toCsvRow(ordered));
  }
  mkdirSync(resolvePath(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n"), "utf8");
}

// --- Main -------------------------------------------------------------------

async function main() {
  loadDevVarsIfPresent();
  const { dryRun, limit, brandSlugs } = parseArgs(process.argv);

  const databaseUrl = process.env.DATABASE_URL;
  const googleApiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx = process.env.GOOGLE_SEARCH_CX;

  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is required. Provide it in environment or .dev.vars"
    );
    process.exit(1);
  }
  if (!googleApiKey || !googleCx) {
    console.error(
      "GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX are required. Provide them in environment or .dev.vars"
    );
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  let brands = [];
  if (brandSlugs.length) {
    brands = await sql/* sql */ `
      select id, name, slug, base_domain, status
      from brands
      where slug = any(${brandSlugs})
      order by name
    `;
    if (limit && brands.length > limit) {
      brands = brands.slice(0, limit);
    }
  } else {
    brands = await sql/* sql */ `
      select id, name, slug, base_domain, status
      from brands
      where status = 'active' and base_domain is null
      order by name
      limit ${limit}
    `;
  }

  console.log(
    `Found ${
      brands.length
    } brand(s) to process. dryRun=${dryRun} limit=${limit} slugs=${
      brandSlugs.join(",") || "(auto)"
    }`
  );

  if (!brands.length) {
    console.log("No brands to process.");
    return;
  }

  const reviewRows = [];
  const failureRows = [];

  let autoAccepted = 0;
  let sentToReview = 0;
  let failures = 0;

  for (const [idx, brand] of brands.entries()) {
    console.log(
      `Processing brand ${idx + 1}/${brands.length}: ${brand.name} (slug=${
        brand.slug
      }, id=${brand.id})`
    );
    const { outcome } = await resolveDomainForBrand({
      sql,
      brand,
      apiKey: googleApiKey,
      cx: googleCx,
      dryRun,
      reviewRows,
      failureRows,
    });

    if (outcome === "auto_accept") autoAccepted += 1;
    else if (outcome === "review") sentToReview += 1;
    else failures += 1;

    await sleep(200);
  }

  const outDir = resolvePath(process.cwd(), "temp", "data");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  if (reviewRows.length) {
    const reviewPath = resolvePath(outDir, `brand_domain_reviews_${ts}.csv`);
    writeCsv(
      reviewPath,
      [
        "brand_id",
        "brand_name",
        "brand_slug",
        "chosen_domain",
        "score",
        "second_best_domain",
        "second_best_score",
      ],
      reviewRows
    );
    console.log(`Wrote ${reviewRows.length} review row(s) to ${reviewPath}`);
  } else {
    console.log("No brands added to review CSV.");
  }

  if (failureRows.length) {
    const failurePath = resolvePath(outDir, `brand_domain_failures_${ts}.csv`);
    writeCsv(
      failurePath,
      ["brand_id", "brand_name", "brand_slug", "reason"],
      failureRows
    );
    console.log(`Wrote ${failureRows.length} failure row(s) to ${failurePath}`);
  } else {
    console.log("No failures to write to CSV.");
  }

  console.log(
    `Done. Brands processed=${brands.length}, auto_accepted=${autoAccepted}, review=${sentToReview}, failures=${failures}.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
