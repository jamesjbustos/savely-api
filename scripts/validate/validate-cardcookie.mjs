import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

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

function extractExternalIdFromUrl(url) {
  if (!url) return "";
  const m = String(url).match(/\/buy-gift-cards\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (set in .dev.vars or env).");
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  // Resolve CardCookie provider id
  const providerSlug = "cardcookie";
  const provider = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!provider?.[0]?.id) {
    console.error("Provider 'cardcookie' not found. Run ingest:cardcookie at least once.");
    process.exit(1);
  }
  const providerId = provider[0].id;

  const rows = await sql/* sql */ `
    select id, brand_id, variant, product_external_id, product_url, is_active
    from provider_brand_products
    where provider_id = ${providerId}
  `;

  const byKey = new Map(); // key = expectedExternalId from URL
  const problems = {
    emptyExternalId: [],
    urlShapeIssues: [],
    externalIdMismatch: [],
    duplicateExternalId: [],
    multipleActiveVariants: [],
  };

  for (const r of rows) {
    const url = r.product_url || "";
    const ext = (r.product_external_id || "").trim();
    const expectedExt = extractExternalIdFromUrl(url);

    if (!expectedExt) {
      problems.urlShapeIssues.push({
        id: r.id,
        product_external_id: ext,
        product_url: url,
      });
    }
    if (!ext) {
      problems.emptyExternalId.push({
        id: r.id,
        product_url: url,
        inferredExternalId: expectedExt || null,
      });
    } else if (expectedExt && ext.toLowerCase() !== expectedExt) {
      problems.externalIdMismatch.push({
        id: r.id,
        product_external_id: ext,
        expectedExternalId: expectedExt,
        product_url: url,
      });
    }

    const key = expectedExt || ext || `row:${r.id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({
      id: r.id,
      brand_id: r.brand_id,
      variant: r.variant,
      product_external_id: ext,
      product_url: url,
      is_active: r.is_active,
    });
  }

  for (const [key, list] of byKey.entries()) {
    if (!key || key.startsWith("row:")) continue; // skip unparseable keys
    if (list.length > 1) {
      problems.duplicateExternalId.push({
        externalId: key,
        rows: list.map((r) => ({
          id: r.id,
          variant: r.variant,
          url: r.product_url,
          is_active: r.is_active,
        })),
      });
    }
    const active = list.filter((r) => r.is_active);
    const activeVariants = Array.from(new Set(active.map((r) => r.variant)));
    if (activeVariants.length > 1) {
      problems.multipleActiveVariants.push({
        externalId: key,
        activeVariants,
        rows: active.map((r) => ({
          id: r.id,
          variant: r.variant,
          url: r.product_url,
        })),
      });
    }
  }

  const counts = {
    totalDbProducts: rows.length,
    emptyExternalId: problems.emptyExternalId.length,
    urlShapeIssues: problems.urlShapeIssues.length,
    externalIdMismatch: problems.externalIdMismatch.length,
    duplicateExternalId: problems.duplicateExternalId.length,
    multipleActiveVariants: problems.multipleActiveVariants.length,
  };

  console.log("CardCookie Validation Report");
  console.log(JSON.stringify(counts, null, 2));

  function printSample(title, arr, limit = 20) {
    if (!arr.length) return;
    console.log(`\n${title} (showing up to ${limit}):`);
    for (const item of arr.slice(0, limit)) {
      console.log(JSON.stringify(item));
    }
  }

  printSample("Empty external id", problems.emptyExternalId);
  printSample("URL shape issues", problems.urlShapeIssues);
  printSample("External id mismatches", problems.externalIdMismatch);
  printSample("Duplicate external ids", problems.duplicateExternalId);
  printSample("Multiple active variants", problems.multipleActiveVariants);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


