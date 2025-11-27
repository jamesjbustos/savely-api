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

function toTitleCase(input) {
  return input.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, p1, p2) => `${p1}${p2.toUpperCase()}`);
}

function normalizeBrandName(rawName) {
  if (!rawName || typeof rawName !== "string") return "";
  let name = rawName.normalize("NFKC").trim();
  name = name.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[®™]/g, "");
  // Targeted mappings shared with other ingestors
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
  name = name.replace(/^(\d+)[\s-]+(\d+)\b[\s-]*/i, (m, g1, g2) => `${g1}-${g2}-`);
  name = name.replace(/^(\d+-\d+)-$/, "$1");
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    name = toTitleCase(name);
  }
  name = name.replace(/\s*-\s*/g, "-").replace(/-+/g, "-").replace(/\s+/g, " ").trim();
  name = name.replace(/^-+|-+$/g, "");
  return name;
}

function slugifyBrandName(name) {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (set in .dev.vars or env).");
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  // Ensure provider exists
  const providerSlug = "cardcenter";
  const providerName = "CardCenter";
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

  // Fetch brands JSON
  const res = await fetch("https://cardcenter.cc/Api/Shop/Brands", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
  });
  if (!res.ok) {
    console.error(`Failed to fetch CardCenter brands: ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  console.log(`Fetched ${items.length} CardCenter brands`);

  const nowTs = new Date().toISOString();

  // Mark all existing CardCenter discounts out of stock; loop will mark seen ones true
  await sql/* sql */ `
    update provider_brand_discounts
    set in_stock = false, fetched_at = ${nowTs}
    where provider_id = ${providerId}
  `;

  let processed = 0;

  for (const item of items) {
    const brand = item?.brand;
    if (!brand) continue;
    const providerBrandName = String(brand.name ?? "").trim();
    const providerBrandSlug = String(brand.slug ?? "").trim();
    const externalId = String(brand.id ?? "").trim();
    if (!providerBrandName || !providerBrandSlug || !externalId) continue;

    const normalizedName = normalizeBrandName(providerBrandName);
    if (!normalizedName) continue;
    const brandSlug = slugifyBrandName(normalizedName);

    // Upsert brand (match by normalized name if exists)
    let brandId;
    const byName = await sql/* sql */ `
      select id, slug from brands where lower(name) = lower(${normalizedName}) limit 1
    `;
    if (byName?.length) {
      brandId = byName[0].id;
      const existingSlug = byName[0].slug;
      if (existingSlug !== brandSlug) {
        const slugOwner = await sql/* sql */ `
          select id from brands where slug = ${brandSlug} limit 1
        `;
        if (!slugOwner?.length || slugOwner[0].id === brandId) {
          await sql/* sql */ `
            update brands set slug = ${brandSlug}, updated_at = now() where id = ${brandId}
          `;
        }
      }
    } else {
      const ins = await sql/* sql */ `
        insert into brands (name, slug)
        values (${normalizedName}, ${brandSlug})
        on conflict (slug)
        do update set name = excluded.name, updated_at = now()
        returning id
      `;
      brandId = ins[0].id;
    }

    // Alias original name if different
    if (providerBrandName && providerBrandName.toLowerCase() !== normalizedName.toLowerCase()) {
      await sql/* sql */ `
        insert into brand_aliases (brand_id, alias)
        values (${brandId}, ${providerBrandName})
        on conflict do nothing
      `;
    }

    // Max discount: use "high" fraction * 100
    const high = Number(item?.discounts?.high ?? 0) || 0;
    const maxDiscountPercent = Math.max(0, high * 100);
    const inStock = true; // endpoint only returns available brands

    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${maxDiscountPercent}, ${inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;

    // Product: single URL per brand; CardCenter sells online codes only
    const productUrl = `https://cardcenter.cc/shop/gift-cards/${providerBrandSlug}`;
    const variant = "online";

    await sql/* sql */ `
      insert into provider_brand_products
        (provider_id, brand_id, variant, product_external_id, product_url, is_active, last_seen_at, last_checked_at, card_image_url)
      values
        (${providerId}, ${brandId}, ${variant}, ${externalId}, ${productUrl}, ${true}, ${nowTs}, ${nowTs}, ${null})
      on conflict do nothing
    `;
    await sql/* sql */ `
      update provider_brand_products
      set
        is_active = true,
        last_seen_at = ${nowTs},
        last_checked_at = ${nowTs},
        product_url = ${productUrl},
        card_image_url = null
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and variant = ${variant}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
    `;
    // Enforce single row per external id for this provider/brand by removing others
    await sql/* sql */ `
      delete from provider_brand_products
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
        and variant <> ${variant}
    `;

    processed += 1;
    if (processed % 100 === 0) {
      console.log(`Processed ${processed} CardCenter brands...`);
    }
  }

  console.log(`Done. Processed ${processed} CardCenter brands.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


