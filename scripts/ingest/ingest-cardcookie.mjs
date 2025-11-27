import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import { load as loadHtml } from "cheerio";

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
    // ignore missing
  }
}

function toTitleCase(input) {
  return input.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, p1, p2) => `${p1}${p2.toUpperCase()}`);
}

function normalizeBrandName(rawName) {
  if (!rawName || typeof rawName !== "string") return "";
  let name = rawName.normalize("NFKC").trim();
  name = name.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[®™]/g, "");
  // Targeted canonical mappings (brand-specific)
  {
    const rawLower = rawName.toLowerCase();
    if (/\bxbox\s+prepaid\b/.test(rawLower)) return "Xbox";
    if (/\bxbox\s+game\s+pass\b/.test(rawLower)) return "Xbox Game Pass";
  }
  // Remove "Powered by ..." suffixes
  name = name.replace(/\bpowered\s+by\s+.+$/i, " ").trim();
  // Remove any parenthetical qualifiers e.g., (Online only)
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
  name = name.replace(/\s+/g, " ").trim();
  // Standardize leading "1 800"/"1-800" and hyphenate next token
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

function mapVariantFromStrings(name, title) {
  const n = String(name || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  if (/\bin[\s-]?store\b/.test(n) || /\bphysical\b/.test(n) || /\bin[\s-]?store\b/.test(t)) return "in_store";
  if (/\bonline\s+only\b/.test(n) || /\be[\s-]?gift\b/.test(n) || /\bapp\s+only\b/.test(n)) return "online";
  if (/\bonline\s+only\b/.test(t)) return "online";
  return "other";
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  // Ensure provider exists
  const providerSlug = "cardcookie";
  const providerName = "CardCookie";
  await sql/* sql */ `
    insert into providers (name, slug)
    values (${providerName}, ${providerSlug})
    on conflict (slug) do nothing
  `;
  const providerRow = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!providerRow?.[0]?.id) {
    console.error("Failed to resolve provider id for CardCookie");
    process.exit(1);
  }
  const providerId = providerRow[0].id;

  // Fetch homepage
  const res = await fetch("https://cardcookie.com/", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
  });
  if (!res.ok) {
    console.error(`Failed to fetch CardCookie homepage: ${res.status}`);
    process.exit(1);
  }
  const html = await res.text();
  const $ = loadHtml(html);

  const nowTs = new Date().toISOString();
  const seenBrandIds = new Set();
  const seenExternalIds = new Set();

  const anchors = $(".gift-card-grid a.giftCard-link");
  console.log(`Found ${anchors.length} CardCookie items on homepage`);

  // Mark all existing CardCookie discounts as out of stock; loop will set true for seen ones
  await sql/* sql */ `
    update provider_brand_discounts
    set in_stock = false, fetched_at = ${nowTs}
    where provider_id = ${providerId}
  `;

  for (const el of anchors.toArray()) {
    const $a = $(el);
    const href = ($a.attr("href") || "").trim();
    const title = ($a.attr("title") || "").trim();
    const dataPct = $a.attr("data") || "";
    const placeholderText = $a.find(".gcr-placeholder").text().trim();
    const spanNameText = $a.find(".giftCard-name").text().trim();
    // Prefer clean sources for brand name to avoid "Sale!" noise
    const chosenName =
      title ||
      placeholderText ||
      spanNameText.replace(/\s+Sale!$/i, "").trim();

    if (!href || !href.includes("/buy-gift-cards/")) continue;
    const slug = href.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "");
    const pathMatch = slug.match(/^buy-gift-cards\/([^/?#]+)/i);
    if (!pathMatch) continue;
    const externalId = pathMatch[1].toLowerCase(); // provider-specific stable id
    seenExternalIds.add(externalId);

    const maxDiscountPercent = (() => {
      const m = String(dataPct).match(/(\d+(\.\d+)?)\s*%/);
      if (m) return parseFloat(m[1]);
      const t = $a.find(".giftCard-discount").text() || "";
      const m2 = t.match(/(\d+(\.\d+)?)\s*%/);
      return m2 ? parseFloat(m2[1]) : 0;
    })();

    const providerBrandName =
      chosenName || externalId.replace(/-/g, " ");
    const normalizedName = normalizeBrandName(providerBrandName);
    const brandSlug = slugifyBrandName(normalizedName);
    const variant = mapVariantFromStrings(providerBrandName, title);
    const inStock = true; // appears on homepage
    const productUrl = `https://cardcookie.com/${slug}`;

    // Upsert brand
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
    seenBrandIds.add(brandId);

    // Alias original name if different
    if (
      providerBrandName &&
      providerBrandName.toLowerCase() !== normalizedName.toLowerCase() &&
      !/sale!?$/i.test(providerBrandName.trim())
    ) {
      await sql/* sql */ `
        insert into brand_aliases (brand_id, alias)
        values (${brandId}, ${providerBrandName})
        on conflict do nothing
      `;
    }

    // Upsert discounts
    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${maxDiscountPercent}, ${inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;

    // Upsert product row (external id = CardCookie slug)
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
    // Keep only the selected variant per external id
    await sql/* sql */ `
      delete from provider_brand_products
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
        and variant <> ${variant}
    `;
  }

  console.log(`Done. Processed ${anchors.length} CardCookie items.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


