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
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // ignore
  }
}

function baseUrl(url) {
  if (!url) return "";
  return String(url).split("?")[0];
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (set in .dev.vars or env).");
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  const providerSlug = "carddepot";
  const provider = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!provider?.[0]?.id) {
    console.error(
      "Provider 'carddepot' not found. Run ingest:carddepot at least once."
    );
    process.exit(1);
  }
  const providerId = provider[0].id;

  // Fetch OG data from CardDepot
  const res = await fetch("https://carddepot.com/api/brands?type=savely", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
  });
  if (!res.ok) {
    console.error(`Failed to fetch CardDepot brands: ${res.status}`);
    process.exit(1);
  }
  const items = await res.json();
  if (!Array.isArray(items)) {
    console.error("Unexpected CardDepot response shape (expected array).");
    process.exit(1);
  }

  const ogByExternalId = new Map();
  for (const item of items) {
    const slug = String(item?.slug ?? "").trim();
    if (!slug) continue;
    const ext = slug; // external id in DB
    const expectedUrl = `https://carddepot.com/brands/${slug}`;
    ogByExternalId.set(ext, {
      externalId: ext,
      slug,
      expectedUrl,
      name: item?.title ?? null,
    });
  }

  // DB state
  const rows = await sql/* sql */ `
    select
      p.id,
      p.brand_id,
      b.name as brand_name,
      p.variant,
      p.product_external_id,
      p.product_url,
      p.is_active
    from provider_brand_products p
    join brands b on b.id = p.brand_id
    where p.provider_id = ${providerId}
  `;

  const dbByExternalId = new Map();
  for (const r of rows) {
    const ext = String(r.product_external_id ?? "").trim();
    if (!ext) continue;
    if (!dbByExternalId.has(ext)) dbByExternalId.set(ext, []);
    dbByExternalId.get(ext).push({
      id: r.id,
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      variant: r.variant,
      url: r.product_url,
      is_active: r.is_active,
    });
  }

  const problems = {
    missingInDb: [],
    missingInOg: [],
    urlMismatch: [],
    duplicateExternalId: [],
    multipleActiveVariants: [],
  };

  // OG → DB checks
  for (const [ext, og] of ogByExternalId.entries()) {
    const list = dbByExternalId.get(ext) || [];
    if (!list.length) {
      problems.missingInDb.push({
        externalId: ext,
        expectedUrl: og.expectedUrl,
        name: og.name,
      });
      continue;
    }
    const baseExpected = baseUrl(og.expectedUrl);
    const bases = Array.from(new Set(list.map((r) => baseUrl(r.url))));
    if (!bases.includes(baseExpected)) {
      problems.urlMismatch.push({
        externalId: ext,
        expectedUrl: og.expectedUrl,
        dbUrls: list.map((r) => r.url).slice(0, 5),
        name: og.name,
      });
    }
    if (list.length > 1) {
      problems.duplicateExternalId.push({
        externalId: ext,
        rows: list.map((r) => ({
          id: r.id,
          brand_id: r.brand_id,
          brand_name: r.brand_name,
          variant: r.variant,
          url: r.url,
          is_active: r.is_active,
        })),
      });
    }
    const active = list.filter((r) => r.is_active);
    const activeVariants = Array.from(new Set(active.map((r) => r.variant)));
    if (activeVariants.length > 1) {
      problems.multipleActiveVariants.push({
        externalId: ext,
        activeVariants,
        rows: active.map((r) => ({
          id: r.id,
          brand_id: r.brand_id,
          brand_name: r.brand_name,
          variant: r.variant,
          url: r.url,
        })),
      });
    }
  }

  // DB → OG checks
  for (const ext of dbByExternalId.keys()) {
    if (!ogByExternalId.has(ext)) {
      const list = dbByExternalId.get(ext) || [];
      problems.missingInOg.push({
        externalId: ext,
        dbUrls: list.map((r) => r.url).slice(0, 5),
      });
    }
  }

  const counts = {
    totalOgProducts: ogByExternalId.size,
    totalDbProducts: rows.length,
    missingInDb: problems.missingInDb.length,
    missingInOg: problems.missingInOg.length,
    urlMismatch: problems.urlMismatch.length,
    duplicateExternalId: problems.duplicateExternalId.length,
    multipleActiveVariants: problems.multipleActiveVariants.length,
  };

  console.log("CardDepot Validation Report");
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
  printSample("URL mismatches (DB vs expected from slug)", problems.urlMismatch);
  printSample("Duplicate external ids", problems.duplicateExternalId);
  printSample("Multiple active variants per external id", problems.multipleActiveVariants);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


