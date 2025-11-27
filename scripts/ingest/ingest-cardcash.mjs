import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

// Load .dev.vars into process.env if present (simple parser: KEY="value")
function loadDevVarsIfPresent() {
  const devVarsPath = resolve(process.cwd(), ".dev.vars");
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

function toTitleCase(input) {
  // Title-case letters after spaces or hyphens
  return input
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (m, p1, p2) => `${p1}${p2.toUpperCase()}`);
}

function normalizeBrandName(rawName) {
  if (!rawName || typeof rawName !== "string") return "";
  let name = rawName.normalize("NFKC").trim();
  // Normalize punctuation, remove trademark symbols
  name = name.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[®™]/g, "");
  // Targeted canonical mappings (brand-specific)
  {
    const rawLower = rawName.toLowerCase();
    if (/\bxbox\s+prepaid\b/.test(rawLower)) return "Xbox";
    if (/\bxbox\s+game\s+pass\b/.test(rawLower)) return "Xbox Game Pass";
  }
  // Remove "Powered by ..." suffixes
  name = name.replace(/\bpowered\s+by\s+.+$/i, " ").trim();
  // Remove any parenthetical qualifiers e.g., (App Only)
  name = name.replace(/\([^)]*\)/g, " ").trim();
  // Remove .com fragments
  name = name.replace(/\.com\b/gi, " ").trim();
  // Remove common qualifiers/noise
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
  // Collapse spaces
  name = name.replace(/\s+/g, " ").trim();
  // Standardize leading "1 800"/"1-800" and hyphenate next token
  name = name.replace(
    /^(\d+)[\s-]+(\d+)\b[\s-]*/i,
    (m, g1, g2) => `${g1}-${g2}-`
  );
  // If we ended with trailing hyphen (no next token), fix to "1-800"
  name = name.replace(/^(\d+-\d+)-$/, "$1");
  // Title-case if clearly not mixed case
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (
    letters &&
    (letters === letters.toUpperCase() || letters === letters.toLowerCase())
  ) {
    name = toTitleCase(name);
  }
  // Tidy hyphens and spaces
  name = name
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
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

function buildAliasVariants(name) {
  const variants = new Set();
  const base = normalizeBrandName(name);
  if (base) variants.add(base);
  // & <-> and variants
  if (base.includes("&")) variants.add(base.replace(/&/g, "and"));
  if (/\band\b/i.test(base)) variants.add(base.replace(/\band\b/gi, "&"));
  // Remove dots (e.g., "1 800 Flowers.com" -> "1 800 Flowers")
  variants.add(base.replace(/\./g, "").trim());
  // 1-800 variants: swap hyphens and spaces after number groups
  if (/^\d+-\d+-/i.test(base)) {
    const rest = base.replace(/^\d+-\d+-/i, "");
    variants.add(`1 800 ${rest}`);
    variants.add(`1-800 ${rest}`);
    variants.add(`1 800-${rest}`);
  }
  // Collapse multiple spaces
  for (const v of Array.from(variants)) {
    variants.add(v.replace(/\s+/g, " ").trim());
  }
  // Filter empties
  return Array.from(variants).filter(Boolean);
}

function mapCardTypeToVariant(cardType) {
  if (!cardType) return "other";
  const t = String(cardType).toLowerCase();
  if (
    t.includes("ecode") ||
    t.includes("e-code") ||
    t.includes("digital") ||
    t.includes("online")
  )
    return "online";
  if (t.includes("in-store") || t.includes("instore") || t.includes("store"))
    return "in_store";
  return "other";
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is required. Provide it in environment or .dev.vars"
    );
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  // Ensure provider exists and fetch id
  const providerSlug = "cardcash";
  const providerName = "CardCash";
  await sql/* sql */ `
    insert into providers (name, slug)
    values (${providerName}, ${providerSlug})
    on conflict (slug) do nothing
  `;
  const providerRow = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!providerRow?.[0]?.id) {
    console.error("Failed to resolve provider id for CardCash");
    process.exit(1);
  }
  const providerId = providerRow[0].id;

  // Load JSON
  const jsonPath = resolve(process.cwd(), "data", "cardcash.json");
  const raw = readFileSync(jsonPath, "utf8");
  const data = JSON.parse(raw);
  const merchants = Array.isArray(data?.buyMerchants) ? data.buyMerchants : [];

  const nowTs = new Date().toISOString();
  let processed = 0;

  for (const m of merchants) {
    const externalId = String(m.id ?? "");
    const providerBrandName = String(m.name ?? "").trim();
    if (!externalId || !providerBrandName) continue;

    const normalizedName = normalizeBrandName(providerBrandName);
    if (!normalizedName) continue;
    const brandSlug = slugifyBrandName(normalizedName);

    // Find existing brand by normalized name (respects uq on lower(name))
    let brandId;
    const byName = await sql/* sql */ `
      select id, slug from brands where lower(name) = lower(${normalizedName}) limit 1
    `;
    if (byName?.length) {
      brandId = byName[0].id;
      const existingSlug = byName[0].slug;
      if (existingSlug !== brandSlug) {
        // Update slug if not used by another brand
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
      // Try to find a candidate brand that normalizes to the same canonical name.
      const likeNorm = `%${normalizedName.toLowerCase()}%`;
      const likeRaw = `%${providerBrandName.toLowerCase()}%`;
      const candidates = await sql/* sql */ `
        select id, name, slug
        from brands
        where lower(name) like ${likeNorm}
           or lower(name) like ${likeRaw}
        limit 10
      `;
      let matched = null;
      for (const c of candidates) {
        try {
          if (normalizeBrandName(c.name) === normalizedName) {
            matched = c;
            break;
          }
        } catch {}
      }
      if (matched) {
        brandId = matched.id;
        // Update canonical name and slug if needed
        if (matched.name !== normalizedName) {
          await sql/* sql */ `
            update brands set name = ${normalizedName}, updated_at = now() where id = ${brandId}
          `;
        }
        if (matched.slug !== brandSlug) {
          const slugOwner = await sql/* sql */ `
            select id from brands where slug = ${brandSlug} limit 1
          `;
          if (!slugOwner?.length || slugOwner[0].id === brandId) {
            await sql/* sql */ `
              update brands set slug = ${brandSlug}, updated_at = now() where id = ${brandId}
            `;
          }
        }
        // Keep the old displayed name as an alias
        if (
          matched.name &&
          matched.name.toLowerCase() !== normalizedName.toLowerCase()
        ) {
          await sql/* sql */ `
            insert into brand_aliases (brand_id, alias)
            values (${brandId}, ${matched.name})
            on conflict do nothing
          `;
        }
      } else {
        const brandRows = await sql/* sql */ `
          insert into brands (name, slug)
          values (${normalizedName}, ${brandSlug})
          on conflict (slug)
          do update set name = excluded.name, updated_at = now()
          returning id
        `;
        brandId = brandRows[0].id;
      }
    }

    // Merge duplicate brand rows that normalize to the same canonical name (cleanup legacy rows)
    {
      const dupCandidates = await sql/* sql */ `
        select id, name, slug from brands
        where id <> ${brandId}
          and (lower(name) like ${`%${normalizedName.toLowerCase()}%`} or lower(name) like ${`%${providerBrandName.toLowerCase()}%`})
        limit 50
      `;
      for (const dup of dupCandidates) {
        try {
          if (normalizeBrandName(dup.name) !== normalizedName) continue;
        } catch {
          continue;
        }
        const oldBrandId = dup.id;
        // Preserve old display name as alias
        if (
          dup.name &&
          dup.name.toLowerCase() !== normalizedName.toLowerCase()
        ) {
          await sql/* sql */ `
            insert into brand_aliases (brand_id, alias)
            values (${brandId}, ${dup.name})
            on conflict do nothing
          `;
        }
        // Upsert discounts for this provider into canonical, then remove old
        const oldDisc = await sql/* sql */ `
          select provider_id, brand_id, max_discount_percent, in_stock, fetched_at
          from provider_brand_discounts
          where brand_id = ${oldBrandId}
        `;
        for (const d of oldDisc) {
          await sql/* sql */ `
            insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
            values (${d.provider_id}, ${brandId}, ${d.max_discount_percent}, ${d.in_stock}, ${d.fetched_at})
            on conflict (provider_id, brand_id)
            do update set
              max_discount_percent = greatest(provider_brand_discounts.max_discount_percent, excluded.max_discount_percent),
              in_stock = provider_brand_discounts.in_stock or excluded.in_stock,
              fetched_at = greatest(provider_brand_discounts.fetched_at, excluded.fetched_at)
          `;
        }
        await sql/* sql */ `
          delete from provider_brand_discounts where brand_id = ${oldBrandId}
        `;
        // Move products for all providers to canonical:
        // 1) Update existing destination rows with latest metadata
        await sql/* sql */ `
          update provider_brand_products dest
          set
            is_active = dest.is_active or src.is_active,
            last_seen_at = greatest(dest.last_seen_at, src.last_seen_at),
            last_checked_at = greatest(dest.last_checked_at, src.last_checked_at),
            product_url = coalesce(src.product_url, dest.product_url),
            card_image_url = null,
            last_status = coalesce(src.last_status, dest.last_status),
            last_error = coalesce(src.last_error, dest.last_error),
            retry_count = greatest(dest.retry_count, src.retry_count)
          from provider_brand_products src
          where src.brand_id = ${oldBrandId}
            and dest.provider_id = src.provider_id
            and dest.brand_id = ${brandId}
            and dest.variant = src.variant
            and coalesce(dest.product_external_id, '') = coalesce(src.product_external_id, '')
        `;
        // 2) Insert any rows that don't already exist in destination
        await sql/* sql */ `
          insert into provider_brand_products
            (provider_id, brand_id, variant, product_external_id, product_url, is_active, first_seen_at, last_seen_at, last_checked_at, last_status, last_error, retry_count, card_image_url)
          select
            provider_id, ${brandId}, variant, product_external_id, product_url, is_active, first_seen_at, last_seen_at, last_checked_at, last_status, last_error, retry_count, null as card_image_url
          from provider_brand_products src
          where src.brand_id = ${oldBrandId}
            and not exists (
              select 1
              from provider_brand_products dest
              where dest.provider_id = src.provider_id
                and dest.brand_id = ${brandId}
                and dest.variant = src.variant
                and coalesce(dest.product_external_id, '') = coalesce(src.product_external_id, '')
            )
        `;
        // 3) Remove redundant 'other' variants when a specific variant exists
        await sql/* sql */ `
          delete from provider_brand_products p
          where p.provider_id = ${providerId}
            and p.brand_id = ${brandId}
            and p.variant = 'other'
            and exists (
              select 1
              from provider_brand_products s
              where s.provider_id = p.provider_id
                and s.brand_id = p.brand_id
                and coalesce(s.product_external_id, '') = coalesce(p.product_external_id, '')
                and s.variant in ('online','in_store')
            )
        `;
        // Update listings to canonical and null product link to avoid FK issues, then we'll rely on fresh data later
        await sql/* sql */ `
          update provider_brand_listings
          set brand_id = ${brandId}, product_id = null
          where brand_id = ${oldBrandId}
        `;
        // Finally, delete old brand (cascades aliases)
        await sql/* sql */ `
          delete from brands where id = ${oldBrandId}
        `;
      }
    }

    // Upsert aliases (provider name + provided aliases + variants)
    const aliasSet = new Set();
    for (const v of buildAliasVariants(providerBrandName)) aliasSet.add(v);
    if (Array.isArray(m.aliases)) {
      for (const a of m.aliases) {
        for (const v of buildAliasVariants(a)) aliasSet.add(v);
      }
    }
    for (const alias of aliasSet) {
      // Skip if same as canonical name
      if (alias.toLowerCase() === normalizedName.toLowerCase()) continue;
      await sql/* sql */ `
        insert into brand_aliases (brand_id, alias)
        values (${brandId}, ${alias})
        on conflict do nothing
      `;
    }
    // Always include the original provider-supplied name as an alias
    if (
      providerBrandName &&
      providerBrandName.toLowerCase() !== normalizedName.toLowerCase()
    ) {
      await sql/* sql */ `
        insert into brand_aliases (brand_id, alias)
        values (${brandId}, ${providerBrandName})
        on conflict do nothing
      `;
    }

    // Availability and discount
    const cardsAvailable = Number(m.cardsAvailable ?? 0) || 0;
    const ecodesAvailable = Number(m.ecodesAvailable ?? 0) || 0;
    const inStock = cardsAvailable + ecodesAvailable > 0;
    const maxDiscountPercent = Math.max(0, Number(m.upToPercentage ?? 0)) || 0;

    // Upsert provider_brand_discounts (one per brand/provider)
    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${maxDiscountPercent}, ${inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;

    // Upsert provider_brand_products (captures external id, variant, url, image)
    // Variant: prefer signal in name when present, else fall back to cardType
    let variant = mapCardTypeToVariant(m.cardType ?? null);
    const nameLower = providerBrandName.toLowerCase();
    if (/\bin[\s-]?store\b/.test(nameLower)) variant = "in_store";
    if (/\bphysical\b/.test(nameLower)) variant = "in_store";
    if (
      /\bonline\s+only\b/.test(nameLower) ||
      /\be[\s-]?gift\b/.test(nameLower) ||
      /\bapp\s+only\b/.test(nameLower)
    )
      variant = "online";
    const productUrl = m.slug
      ? `https://www.cardcash.com/buy-gift-cards/${String(m.slug).replace(
          /^\/+/,
          ""
        )}`
      : `https://www.cardcash.com/buy-gift-cards/`;
    const cardImageUrl = null; // do not persist provider image URLs
    await sql/* sql */ `
      insert into provider_brand_products
        (provider_id, brand_id, variant, product_external_id, product_url, is_active, last_seen_at, last_checked_at, card_image_url)
      values
        (${providerId}, ${brandId}, ${variant}, ${externalId}, ${productUrl}, ${true}, ${nowTs}, ${nowTs}, ${cardImageUrl})
      on conflict do nothing
    `;
    // Follow-up update to emulate upsert on the expression unique index
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
    // Ensure all rows for this external id use the corrected URL and image policy
    await sql/* sql */ `
      update provider_brand_products
      set product_url = ${productUrl},
          card_image_url = null
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
    `;
    // Activate only the computed variant and deactivate others for this product
    await sql/* sql */ `
      update provider_brand_products
      set is_active = (variant = ${variant})
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
    `;
    // Remove redundant 'other' variant when a specific variant exists for same product_external_id
    await sql/* sql */ `
      delete from provider_brand_products p
      where p.provider_id = ${providerId}
        and p.brand_id = ${brandId}
        and p.variant = 'other'
        and coalesce(p.product_external_id, '' ) = coalesce(${externalId}, '' )
        and exists (
          select 1
          from provider_brand_products s
          where s.provider_id = p.provider_id
            and s.brand_id = p.brand_id
            and coalesce(s.product_external_id, '' ) = coalesce(p.product_external_id, '' )
            and s.variant in ('online','in_store')
        )
    `;

    processed += 1;
    if (processed % 100 === 0) {
      console.log(`Processed ${processed} merchants...`);
    }
  }

  console.log(`Done. Processed ${processed} merchants from CardCash.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
