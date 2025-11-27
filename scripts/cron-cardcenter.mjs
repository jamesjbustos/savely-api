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

async function main() {
  loadDevVarsIfPresent();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (set in .dev.vars or env).");
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  // Resolve CardCenter provider
  const providerSlug = "cardcenter";
  const providerName = "CardCenter";

  // Ensure provider row exists (safe idempotent insert)
  await sql/* sql */ `
    insert into providers (name, slug)
    values (${providerName}, ${providerSlug})
    on conflict (slug) do nothing
  `;

  const providerRow = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!providerRow?.[0]?.id) {
    console.error("Failed to resolve provider id for CardCenter");
    process.exit(1);
  }
  const providerId = providerRow[0].id;

  // Load existing CardCenter products so we only ever UPDATE, never INSERT
  const existingProducts = await sql/* sql */ `
    select id, brand_id, coalesce(product_external_id, '') as product_external_id
    from provider_brand_products
    where provider_id = ${providerId}
      and variant = 'online'
  `;

  const byExternalId = new Map();
  for (const row of existingProducts) {
    const externalId = String(row.product_external_id ?? "").trim();
    if (!externalId) continue;
    byExternalId.set(externalId, {
      productId: row.id,
      brandId: row.brand_id,
    });
  }

  console.log(
    `Loaded ${existingProducts.length} existing CardCenter products, ` +
      `${byExternalId.size} with a non-empty external id`
  );

  // Fetch current snapshot from CardCenter API (only returns available brands)
  const res = await fetch("https://cardcenter.cc/Api/Shop/Brands", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
  });
  if (!res.ok) {
    console.error(`Failed to fetch CardCenter brands: ${res.status}`);
    process.exit(1);
  }

  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  console.log(`Fetched ${items.length} CardCenter brands from API`);

  const nowTs = new Date().toISOString();

  // 1) Pessimistically mark everything as out-of-stock / inactive.
  //    We'll flip rows back to "true" for anything we see in the API snapshot.
  await sql/* sql */ `
    update provider_brand_discounts
    set in_stock = false,
        fetched_at = ${nowTs}
    where provider_id = ${providerId}
  `;

  await sql/* sql */ `
    update provider_brand_products
    set is_active = false,
        last_checked_at = ${nowTs}
    where provider_id = ${providerId}
      and variant = 'online'
  `;

  let updatedExisting = 0;

  // 2) Walk current API items and update ONLY existing rows.
  for (const item of items) {
    const brand = item?.brand;
    if (!brand) continue;

    const externalId = String(brand.id ?? "").trim();
    const slug = String(brand.slug ?? "").trim();

    if (!externalId || !slug) continue;

    const mapping = byExternalId.get(externalId);
    if (!mapping) {
      // We've never seen this CardCenter brand before in our DB;
      // by design we do not insert new brands in this cron job.
      continue;
    }

    // If CardCenter doesn't provide discounts for this brand, treat it as
    // not currently in stock / not on sale. We already pessimistically
    // marked everything out of stock above, so just skip flips back to true.
    const discounts = item?.discounts;
    const high = Number(discounts?.high ?? 0) || 0;
    const hasDiscount = !!discounts && high > 0;
    if (!hasDiscount) {
      continue;
    }

    const { productId, brandId } = mapping;
    const maxDiscountPercent = Math.max(0, high * 100);

    // CardCenter sells online codes, single URL per brand.
    const productUrl = `https://cardcenter.cc/shop/gift-cards/${slug}`;

    // Update discount row for this brand
    await sql/* sql */ `
      update provider_brand_discounts
      set max_discount_percent = ${maxDiscountPercent},
          in_stock = true,
          fetched_at = ${nowTs}
      where provider_id = ${providerId}
        and brand_id = ${brandId}
    `;

    // Update product row for this external id
    await sql/* sql */ `
      update provider_brand_products
      set is_active = true,
          last_seen_at = ${nowTs},
          last_checked_at = ${nowTs},
          product_url = ${productUrl}
      where id = ${productId}
    `;

    updatedExisting += 1;
    if (updatedExisting % 100 === 0) {
      console.log(`Updated ${updatedExisting} existing CardCenter products...`);
    }
  }

  console.log(
    `Done. Updated ${updatedExisting} existing CardCenter products. ` +
      "Any CardCenter products not present in the latest API snapshot " +
      "have been marked out of stock / inactive."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


