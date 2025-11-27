import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

// Simple .dev.vars loader for local runs
function loadDevVarsIfPresent() {
  const devVarsPath = resolve(process.cwd(), ".dev.vars");
  try {
    const raw = readFileSync(devVarsPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // ignore
  }
}

function expectedProductUrl(slug) {
  if (!slug) return "https://www.cardcash.com/buy-gift-cards/";
  return `https://www.cardcash.com/buy-gift-cards/${String(slug).replace(/^\/+/, "")}`;
}

function inferVariantFromNameAndType(name, cardType) {
  const n = String(name || "").toLowerCase();
  if (/\bin[\s-]?store\b/.test(n) || /\bphysical\b/.test(n)) return "in_store";
  const t = String(cardType || "").toLowerCase();
  if (t.includes("ecode") || t.includes("e-code") || t.includes("digital") || t.includes("online")) return "online";
  if (t.includes("in-store") || t.includes("instore") || t.includes("store")) return "in_store";
  if (/\bonline\s+only\b/.test(n) || /\be[\s-]?gift\b/.test(n) || /\bapp\s+only\b/.test(n)) return "online";
  return "other";
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (set in .dev.vars or env).");
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  // Resolve CardCash provider id
  const providerSlug = "cardcash";
  const provider = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!provider?.[0]?.id) {
    console.error("Provider 'cardcash' not found. Seed providers first.");
    process.exit(1);
  }
  const providerId = provider[0].id;

  // Load OG JSON
  const jsonPath = resolve(process.cwd(), "data", "cardcash.json");
  const raw = readFileSync(jsonPath, "utf8");
  const data = JSON.parse(raw);
  const merchants = Array.isArray(data?.buyMerchants) ? data.buyMerchants : [];

  // Build expectations by external id
  const ogByExternalId = new Map();
  for (const m of merchants) {
    const externalId = String(m.id ?? "");
    if (!externalId) continue;
    ogByExternalId.set(externalId, {
      externalId,
      name: m.name ?? null,
      slug: m.slug ?? null,
      expectedUrl: expectedProductUrl(m.slug),
      expectedVariant: inferVariantFromNameAndType(m.name, m.cardType),
    });
  }

  // Fetch DB rows for this provider keyed by external id
  const rows = await sql/* sql */ `
    select product_external_id, variant, product_url, is_active
    from provider_brand_products
    where provider_id = ${providerId}
  `;

  const dbByExternalId = new Map();
  for (const r of rows) {
    const key = String(r.product_external_id ?? "");
    if (!dbByExternalId.has(key)) dbByExternalId.set(key, []);
    dbByExternalId.get(key).push({
      variant: r.variant,
      url: r.product_url,
      isActive: r.is_active,
    });
  }

  // Compare
  const problems = {
    missingInDb: [],
    missingInOg: [],
    urlMismatch: [],
    variantIssues: [],
    duplicatesWithSameUrl: [],
  };

  // OG → DB checks
  for (const [externalId, og] of ogByExternalId.entries()) {
    const rowsForId = dbByExternalId.get(externalId) || [];
    if (rowsForId.length === 0) {
      problems.missingInDb.push({ externalId, expectedUrl: og.expectedUrl, expectedVariant: og.expectedVariant, name: og.name });
      continue;
    }
    // URL mismatch (any row should carry expected URL)
    const hasExpectedUrl = rowsForId.some((r) => r.url === og.expectedUrl);
    if (!hasExpectedUrl) {
      problems.urlMismatch.push({
        externalId,
        expectedUrl: og.expectedUrl,
        dbUrls: Array.from(new Set(rowsForId.map((r) => r.url))).slice(0, 5),
        name: og.name,
      });
    }
    // Active variant sanity: exactly one active preferred variant if available
    const active = rowsForId.filter((r) => r.isActive);
    const activeVariants = Array.from(new Set(active.map((r) => r.variant)));
    if (activeVariants.length > 1) {
      problems.variantIssues.push({
        externalId,
        reason: "multiple_active_variants",
        activeVariants,
        name: og.name,
      });
    } else if (activeVariants.length === 1) {
      const current = activeVariants[0];
      // If OG suggests a specific variant (not 'other'), prefer it
      if (og.expectedVariant !== "other" && current !== og.expectedVariant) {
        problems.variantIssues.push({
          externalId,
          reason: "active_variant_mismatch",
          expectedVariant: og.expectedVariant,
          actualVariant: current,
          name: og.name,
        });
      }
    }
    // Duplicate rows with same URL (noise)
    const urlCounts = new Map();
    for (const r of rowsForId) {
      urlCounts.set(r.url, (urlCounts.get(r.url) || 0) + 1);
    }
    for (const [u, cnt] of urlCounts.entries()) {
      if (cnt > 1) {
        problems.duplicatesWithSameUrl.push({ externalId, url: u, count: cnt, name: og.name });
      }
    }
  }

  // DB → OG checks (stale)
  for (const externalId of dbByExternalId.keys()) {
    if (!ogByExternalId.has(externalId)) {
      problems.missingInOg.push({
        externalId,
        dbUrls: Array.from(new Set(dbByExternalId.get(externalId).map((r) => r.url))).slice(0, 5),
      });
    }
  }

  // Report
  const counts = {
    totalOgProducts: ogByExternalId.size,
    totalDbProducts: dbByExternalId.size,
    missingInDb: problems.missingInDb.length,
    missingInOg: problems.missingInOg.length,
    urlMismatch: problems.urlMismatch.length,
    variantIssues: problems.variantIssues.length,
    duplicatesWithSameUrl: problems.duplicatesWithSameUrl.length,
  };

  console.log("CardCash Validation Report");
  console.log(JSON.stringify(counts, null, 2));

  function printSample(title, arr, limit = 20) {
    if (!arr.length) return;
    console.log(`\n${title} (showing up to ${limit}):`);
    for (const item of arr.slice(0, limit)) {
      console.log(JSON.stringify(item));
    }
  }

  printSample("Missing in DB", problems.missingInDb);
  printSample("Missing in OG JSON (stale in DB)", problems.missingInOg);
  printSample("URL mismatches", problems.urlMismatch);
  printSample("Variant issues", problems.variantIssues);
  printSample("Duplicate rows with same URL", problems.duplicatesWithSameUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


