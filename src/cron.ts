import { getDb } from "./db.ts";
import { load as loadHtml } from "cheerio";
import {
  normalizeBrandName,
  slugifyBrandName,
  mapVariantFromStrings,
} from "./brandUtils.ts";
import { mapIabToCategory } from "./categoryMapping.ts";

type CronEnv = {
  DATABASE_URL: string;
};

type SamsClubCronEnv = CronEnv & {
  RAKUTEN_CLIENT_ID: string;
  RAKUTEN_CLIENT_SECRET: string;
  RAKUTEN_SID: string; // publisher Site ID, used as OAuth scope
};

const SAMS_CLUB_MID = "38733";
const SAMS_CLUB_PROVIDER_SLUG = "samsclub";
const SAMS_CLUB_PROVIDER_NAME = "Sam's Club";
const RAKUTEN_TOKEN_URL = "https://api.linksynergy.com/token";
const RAKUTEN_PRODUCT_SEARCH_URL = "https://api.linksynergy.com/productsearch/1.0";
const SAMS_CLUB_MAX_PAGES = 20; // hard cap; Sam's Club catalog is ~7 pages of 100

/** Append Cardbay UTM tracking params to an outbound provider URL. */
function withUtm(url: string, brandName: string): string {
  const sep = url.includes("?") ? "&" : "?";
  const campaign = encodeURIComponent(brandName);
  return `${url}${sep}utm_source=carddeals&utm_medium=partner&utm_campaign=${campaign}`;
}

const CARD_DEPOT_LINKSYNERGY_SITE_ID = "boIinK7DrQw";
const CARD_DEPOT_LINKSYNERGY_MID = "54136";
const CARD_DEPOT_LINKSYNERGY_OFFER_ID = "2011365";
const CARD_DEPOT_LINKSYNERGY_TYPE = "2";
const CARD_DEPOT_LINKSYNERGY_SUB_ID = "0";

function buildCardDepotProductUrl(slug: string): string {
  const cleanedSlug = String(slug ?? "").replace(/^\/+/, "");
  const rawUrl = cleanedSlug
    ? `https://carddepot.com/brands/${cleanedSlug}`
    : "https://carddepot.com/brands";

  return `https://click.linksynergy.com/link?id=${encodeURIComponent(
    CARD_DEPOT_LINKSYNERGY_SITE_ID
  )}&offerid=${encodeURIComponent(
    CARD_DEPOT_LINKSYNERGY_OFFER_ID
  )}.${encodeURIComponent(
    CARD_DEPOT_LINKSYNERGY_MID
  )}&type=${encodeURIComponent(
    CARD_DEPOT_LINKSYNERGY_TYPE
  )}&murl=${encodeURIComponent(rawUrl)}`;
}

export async function runCardCenterCron(env: CronEnv) {
  const sql = getDb(env);

  const providerSlug = "cardcenter";
  const providerName = "CardCenter";

  // Ensure provider exists (idempotent)
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
    return;
  }
  const providerId = providerRow[0].id;

  // Existing CardCenter products keyed by external id (brand.id from API)
  const existingProducts = await sql/* sql */ `
    select brand_id, coalesce(product_external_id, '') as external_id
    from provider_brand_products
    where provider_id = ${providerId}
      and variant = 'online'
  `;

  const byExternalId = new Map<string, string>();
  for (const row of existingProducts as any[]) {
    const externalId = String(row.external_id ?? "").trim();
    if (!externalId) continue;
    byExternalId.set(externalId, row.brand_id as string);
  }

  // Fetch current snapshot from CardCenter API
  const res = await fetch("https://cardcenter.cc/Api/Shop/Brands", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; CardbayBot/1.0)" },
  });

  if (!res.ok) {
    console.error(`CardCenter cron: failed to fetch brands: ${res.status}`);
    return;
  }

  const data: any = await res.json();
  const items: any[] = Array.isArray(data?.items) ? data.items : [];

  console.log(`CardCenter cron: fetched ${items.length} brands from API`);

  const nowTs = new Date().toISOString();
  const brandDiscounts = new Map<
    string,
    { maxDiscount: number; inStock: boolean }
  >();

  // 1) Pessimistically mark everything as out of stock / inactive
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

  let updated = 0;
  let newBrands = 0;

  // 2) For each item with a discount, upsert brand + discount + product.
  //    Existing brands are matched strictly by external id; names are only
  //    used when creating new pending brands.
  for (const item of items) {
    const brand = item?.brand;
    if (!brand) continue;

    const externalId = String(brand.id ?? "").trim();
    const providerBrandName = String(brand.name ?? "").trim();
    const providerBrandSlug = String(brand.slug ?? "").trim();
    if (!externalId || !providerBrandName || !providerBrandSlug) continue;

    const discounts = item?.discounts;
    const high = Number(discounts?.high ?? 0) || 0;
    const hasDiscount = !!discounts && high > 0;
    if (!hasDiscount) {
      // As before: brands without discounts (e.g., Coach) are treated as
      // out of stock / not on sale, so we don't flip them back to true here.
      continue;
    }

    const variant = "online";

    // Prefer existing brand strictly by external id; only create a new
    // pending brand when we see a brand.id we've never stored before.
    let brandId = byExternalId.get(externalId);

    if (!brandId) {
      const normalizedName = normalizeBrandName(providerBrandName);
      if (!normalizedName) continue;
      const brandSlug = slugifyBrandName(normalizedName);

      const ins = await sql/* sql */ `
        insert into brands (name, slug, status)
        values (${normalizedName}, ${brandSlug}, 'pending')
        on conflict (slug)
        do update set name = excluded.name, updated_at = now()
        returning id
      `;
      brandId = ins[0].id;
      newBrands += 1;
      console.log(
        `CardCenter cron: detected new brand candidate "${normalizedName}" (slug=${brandSlug})`
      );

      // Alias original provider name if it differs from our normalized name
      if (
        providerBrandName &&
        providerBrandName.toLowerCase() !== normalizedName.toLowerCase()
      ) {
        await sql/* sql */ `
          insert into brand_aliases (brand_id, alias)
          values (${brandId!}, ${providerBrandName})
          on conflict do nothing
        `;
      }
    }

    if (!brandId) continue;

    if (!brandId) continue;

    const inStock = true; // items with discounts are treated as available

    // CardCenter's "high" discount is the best available rate.  Zelle is
    // offline so discounts no longer include a Zelle bonus.
    const maxDiscountPercent = high * 100;
    const prev = brandDiscounts.get(brandId) ?? {
      maxDiscount: 0,
      inStock: false,
    };
    brandDiscounts.set(brandId, {
      maxDiscount: Math.max(prev.maxDiscount, maxDiscountPercent),
      inStock: prev.inStock || inStock,
    });

    const productUrl = withUtm(`https://cardcenter.cc/shop/gift-cards/${providerBrandSlug}`, providerBrandName);

    await sql/* sql */ `
      insert into provider_brand_products
        (provider_id, brand_id, variant, product_external_id, product_url, is_active, last_seen_at, last_checked_at)
      values
        (${providerId}, ${brandId}, ${variant}, ${externalId}, ${productUrl}, ${true}, ${nowTs}, ${nowTs})
      on conflict do nothing
    `;
    await sql/* sql */ `
      update provider_brand_products
      set
        is_active = true,
        last_seen_at = ${nowTs},
        last_checked_at = ${nowTs},
        product_url = ${productUrl}
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and variant = ${variant}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
    `;
    await sql/* sql */ `
      delete from provider_brand_products
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
        and variant <> ${variant}
    `;

    updated += 1;
  }

  for (const [brandId, agg] of brandDiscounts.entries()) {
    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${agg.maxDiscount}, ${agg.inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;
  }

  // 3) Append a snapshot of the current state into history
  await sql/* sql */ `
    insert into provider_brand_discount_history (
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      observed_at
    )
    select
      pbd.provider_id,
      pbd.brand_id,
      pbd.max_discount_percent,
      pbd.in_stock,
      pbd.fetched_at
    from provider_brand_discounts pbd
    left join lateral (
      select
        max_discount_percent,
        in_stock
      from provider_brand_discount_history h
      where h.provider_id = pbd.provider_id
        and h.brand_id = pbd.brand_id
      order by observed_at desc
      limit 1
    ) last on true
    where pbd.provider_id = ${providerId}
      and (
        last.max_discount_percent is null
        or last.max_discount_percent is distinct from pbd.max_discount_percent
        or last.in_stock is distinct from pbd.in_stock
      )
  `;

  console.log(
    `CardCenter cron: updated ${updated} brands; ` +
      `${newBrands} new brand candidates marked as pending; ` +
      "all others remain marked out of stock / inactive."
  );
}

export async function runCardDepotCron(env: CronEnv) {
  const sql = getDb(env);

  const providerSlug = "carddepot";
  const providerName = "CardDepot";

  // Ensure provider exists (idempotent)
  await sql/* sql */ `
    insert into providers (name, slug)
    values (${providerName}, ${providerSlug})
    on conflict (slug) do nothing
  `;

  const providerRow = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!providerRow?.[0]?.id) {
    console.error("Failed to resolve provider id for CardDepot");
    return;
  }
  const providerId = providerRow[0].id;

  // Existing CardDepot products keyed by external id (slug from API)
  const existingProducts = await sql/* sql */ `
    select brand_id, coalesce(product_external_id, '') as external_id
    from provider_brand_products
    where provider_id = ${providerId}
  `;

  const byExternalId = new Map<string, string>();
  for (const row of existingProducts as any[]) {
    const externalId = String(row.external_id ?? "").trim();
    if (!externalId) continue;
    byExternalId.set(externalId, row.brand_id as string);
  }

  // Fetch current snapshot from CardDepot API
  const res = await fetch("https://carddepot.com/api/brands?type=savely", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; CardbayBot/1.0)" },
  });

  if (!res.ok) {
    console.error(`CardDepot cron: failed to fetch brands: ${res.status}`);
    return;
  }

  const items: any = await res.json();
  if (!Array.isArray(items)) {
    console.error(
      "CardDepot cron: unexpected response shape (expected array)."
    );
    return;
  }

  console.log(`CardDepot cron: fetched ${items.length} brands from API`);

  const nowTs = new Date().toISOString();
  const brandDiscounts = new Map<
    string,
    { maxDiscount: number; inStock: boolean }
  >();

  // 1) Pessimistically mark everything as out of stock / inactive
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
  `;

  let updated = 0;
  let newBrands = 0;

  // 2) Upsert brand + discount + product for each item
  for (const item of items) {
    const title = String(item?.title ?? "").trim();
    const slug = String(item?.slug ?? "").trim();
    if (!title || !slug) continue;

    // External id is the CardDepot slug that we stored when ingesting
    const externalId = slug;

    const isStock = Boolean(item?.is_stock);
    const discount = Number(item?.discount ?? 0) || 0;

    // Prefer existing brand strictly by external id; only create new pending
    // brands when we see a slug we've never stored before.
    let brandId = byExternalId.get(externalId);

    if (!brandId) {
      const normalizedName = normalizeBrandName(title);
      if (!normalizedName) continue;
      const brandSlug = slugifyBrandName(normalizedName);

      const ins = await sql/* sql */ `
        insert into brands (name, slug, status)
        values (${normalizedName}, ${brandSlug}, 'pending')
        on conflict (slug)
        do update set name = excluded.name, updated_at = now()
        returning id
      `;
      brandId = ins[0].id;
      newBrands += 1;
      console.log(
        `CardDepot cron: detected new brand candidate "${normalizedName}" (slug=${brandSlug})`
      );

      // Alias original title if different
      if (title && title.toLowerCase() !== normalizedName.toLowerCase()) {
        await sql/* sql */ `
          insert into brand_aliases (brand_id, alias)
          values (${brandId!}, ${title})
          on conflict do nothing
        `;
      }
    }

    if (!brandId) continue;

    const productUrl = buildCardDepotProductUrl(slug);
    const maxDiscountPercent = Math.max(0, discount);
    const prev = brandDiscounts.get(brandId) ?? {
      maxDiscount: 0,
      inStock: false,
    };
    brandDiscounts.set(brandId, {
      maxDiscount: Math.max(prev.maxDiscount, maxDiscountPercent),
      inStock: prev.inStock || isStock,
    });

    // Use the title-based heuristics to decide variant
    const variant = mapVariantFromStrings(title, title);

    await sql/* sql */ `
      insert into provider_brand_products
        (provider_id, brand_id, variant, product_external_id, product_url, is_active, last_seen_at, last_checked_at)
      values
        (${providerId}, ${brandId}, ${variant}, ${externalId}, ${productUrl}, ${isStock}, ${nowTs}, ${nowTs})
      on conflict do nothing
    `;
    await sql/* sql */ `
      update provider_brand_products
      set is_active = ${isStock},
          last_seen_at = ${nowTs},
          last_checked_at = ${nowTs},
          product_url = ${productUrl}
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and variant = ${variant}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
    `;
    await sql/* sql */ `
      delete from provider_brand_products
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
        and variant <> ${variant}
    `;

    updated += 1;
  }

  for (const [brandId, agg] of brandDiscounts.entries()) {
    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${agg.maxDiscount}, ${agg.inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;
  }

  // 3) Append a snapshot of the current state into history
  await sql/* sql */ `
    insert into provider_brand_discount_history (
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      observed_at
    )
    select
      pbd.provider_id,
      pbd.brand_id,
      pbd.max_discount_percent,
      pbd.in_stock,
      pbd.fetched_at
    from provider_brand_discounts pbd
    left join lateral (
      select
        max_discount_percent,
        in_stock
      from provider_brand_discount_history h
      where h.provider_id = pbd.provider_id
        and h.brand_id = pbd.brand_id
      order by observed_at desc
      limit 1
    ) last on true
    where pbd.provider_id = ${providerId}
      and (
        last.max_discount_percent is null
        or last.max_discount_percent is distinct from pbd.max_discount_percent
        or last.in_stock is distinct from pbd.in_stock
      )
  `;

  console.log(
    `CardDepot cron: updated ${updated} brands; ` +
      `${newBrands} new brand candidates marked as pending; ` +
      "all others remain marked out of stock / inactive."
  );
}

export async function runCardCookieCron(env: CronEnv) {
  const sql = getDb(env);

  const providerSlug = "cardcookie";
  const providerName = "CardCookie";

  // Ensure provider exists (idempotent)
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
    return;
  }
  const providerId = providerRow[0].id;

  // Existing CardCookie products keyed by external id (slug from URL)
  const existingProducts = await sql/* sql */ `
    select brand_id, coalesce(product_external_id, '') as external_id
    from provider_brand_products
    where provider_id = ${providerId}
  `;

  const byExternalId = new Map<string, string>();
  for (const row of existingProducts as any[]) {
    const externalId = String(row.external_id ?? "").trim();
    if (!externalId) continue;
    byExternalId.set(externalId, row.brand_id as string);
  }

  // Fetch homepage
  const res = await fetch("https://cardcookie.com/", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; CardbayBot/1.0)" },
  });

  if (!res.ok) {
    console.error(`CardCookie cron: failed to fetch homepage: ${res.status}`);
    return;
  }

  const html = await res.text();
  const $ = loadHtml(html);

  const nowTs = new Date().toISOString();
  const brandDiscounts = new Map<
    string,
    { maxDiscount: number; inStock: boolean }
  >();

  const anchors = $(".gift-card-grid a.giftCard-link");
  console.log(`CardCookie cron: found ${anchors.length} items on homepage`);

  // 1) Pessimistically mark everything out of stock / inactive
  await sql/* sql */ `
    update provider_brand_discounts
    set in_stock = false,
        max_discount_percent = 0,
        fetched_at = ${nowTs}
    where provider_id = ${providerId}
  `;

  await sql/* sql */ `
    update provider_brand_products
    set is_active = false,
        last_checked_at = ${nowTs}
    where provider_id = ${providerId}
  `;

  let processed = 0;

  for (const el of anchors.toArray()) {
    const $a = $(el);
    const href = String($a.attr("href") || "").trim();
    const title = String($a.attr("title") || "").trim();
    const dataPct = String($a.attr("data") || "");
    const placeholderText = $a.find(".gcr-placeholder").text().trim();
    const spanNameText = $a.find(".giftCard-name").text().trim();

    const chosenName =
      title || placeholderText || spanNameText.replace(/\s+Sale!$/i, "").trim();

    if (!href || !href.includes("/buy-gift-cards/")) continue;

    let path = href.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "");
    const pathMatch = path.match(/^buy-gift-cards\/([^/?#]+)/i);
    if (!pathMatch) continue;

    const externalId = pathMatch[1].toLowerCase();

    const maxDiscountPercent = (() => {
      const m = dataPct.match(/(\d+(\.\d+)?)\s*%/);
      if (m) return parseFloat(m[1]);
      const t = $a.find(".giftCard-discount").text() || "";
      const m2 = t.match(/(\d+(\.\d+)?)\s*%/);
      return m2 ? parseFloat(m2[1]) : 0;
    })();

    const providerBrandName = chosenName || externalId.replace(/-/g, " ");
    const variant = mapVariantFromStrings(providerBrandName, title);
    const inStock = true; // appears on homepage
    const productUrl = withUtm(`https://cardcookie.com/${path}`, providerBrandName);

    // Prefer existing brand strictly by external id; only create new pending
    // brands when we see a slug we've never stored before.
    let brandId = byExternalId.get(externalId);

    if (!brandId) {
      const normalizedName = normalizeBrandName(providerBrandName);
      if (!normalizedName) continue;
      const brandSlug = slugifyBrandName(normalizedName);

      const ins = await sql/* sql */ `
        insert into brands (name, slug, status)
        values (${normalizedName}, ${brandSlug}, 'pending')
        on conflict (slug)
        do update set name = excluded.name, updated_at = now()
        returning id
      `;
      brandId = ins[0].id;
      console.log(
        `CardCookie cron: detected new brand candidate "${normalizedName}" (slug=${brandSlug})`
      );

      // Alias original name if different and not just "Sale!"
      if (
        providerBrandName &&
        providerBrandName.toLowerCase() !== normalizedName.toLowerCase() &&
        !/sale!?$/i.test(providerBrandName.trim())
      ) {
        await sql/* sql */ `
          insert into brand_aliases (brand_id, alias)
          values (${brandId!}, ${providerBrandName})
          on conflict do nothing
        `;
      }
    }

    if (!brandId) continue;

    const prev = brandDiscounts.get(brandId) ?? {
      maxDiscount: 0,
      inStock: false,
    };
    brandDiscounts.set(brandId, {
      maxDiscount: Math.max(prev.maxDiscount, maxDiscountPercent),
      inStock: prev.inStock || inStock,
    });

    // Upsert product row (external id = CardCookie slug)
    await sql/* sql */ `
      insert into provider_brand_products
        (provider_id, brand_id, variant, product_external_id, product_url, is_active, last_seen_at, last_checked_at)
      values
        (${providerId}, ${brandId}, ${variant}, ${externalId}, ${productUrl}, ${true}, ${nowTs}, ${nowTs})
      on conflict do nothing
    `;
    await sql/* sql */ `
      update provider_brand_products
      set
        is_active = true,
        last_seen_at = ${nowTs},
        last_checked_at = ${nowTs},
        product_url = ${productUrl}
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and variant = ${variant}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
    `;
    await sql/* sql */ `
      delete from provider_brand_products
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
        and variant <> ${variant}
    `;

    processed += 1;
  }

  console.log(`CardCookie cron: processed ${processed} items.`);

  for (const [brandId, agg] of brandDiscounts.entries()) {
    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${agg.maxDiscount}, ${agg.inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;
  }

  // 3) Append a snapshot of the current state into history
  await sql/* sql */ `
    insert into provider_brand_discount_history (
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      observed_at
    )
    select
      pbd.provider_id,
      pbd.brand_id,
      pbd.max_discount_percent,
      pbd.in_stock,
      pbd.fetched_at
    from provider_brand_discounts pbd
    left join lateral (
      select
        max_discount_percent,
        in_stock
      from provider_brand_discount_history h
      where h.provider_id = pbd.provider_id
        and h.brand_id = pbd.brand_id
      order by observed_at desc
      limit 1
    ) last on true
    where pbd.provider_id = ${providerId}
      and (
        last.max_discount_percent is null
        or last.max_discount_percent is distinct from pbd.max_discount_percent
        or last.in_stock is distinct from pbd.in_stock
      )
  `;
}

export async function runGcxCron(env: CronEnv) {
  try {
    const sql = getDb(env);

    const providerSlug = "gcx";
    const providerName = "GCX";

    // Ensure provider exists (idempotent)
    await sql/* sql */ `
    insert into providers (name, slug)
    values (${providerName}, ${providerSlug})
    on conflict (slug) do nothing
  `;

    const providerRow = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
    if (!providerRow?.[0]?.id) {
      console.error("Failed to resolve provider id for GCX");
      return;
    }
    const providerId = providerRow[0].id;

    // Existing GCX products keyed by external id (CardBear store id)
    const existingProducts = await sql/* sql */ `
      select brand_id, product_url, coalesce(product_external_id, '') as external_id
      from provider_brand_products
      where provider_id = ${providerId}
    `;

    type GcxEntry = {
      brandId: string;
      productUrl: string;
    };

    const byExternalId = new Map<string, GcxEntry>();
    for (const row of existingProducts as any[]) {
      const externalId = String(row.external_id ?? "").trim();
      if (!externalId) continue;
      byExternalId.set(externalId, {
        brandId: row.brand_id as string,
        productUrl: String(row.product_url ?? ""),
      });
    }

    const nowTs = new Date().toISOString();

    // Pessimistically mark all GCX discounts/products as inactive. We'll
    // selectively flip entries back to active based on the latest GCX data
    // so we don't keep serving stale 0% offers.
    await sql/* sql */ `
      update provider_brand_discounts
      set in_stock = false,
          max_discount_percent = 0,
          fetched_at = ${nowTs}
      where provider_id = ${providerId}
    `;

    await sql/* sql */ `
      update provider_brand_products
      set is_active = false,
          last_checked_at = ${nowTs}
      where provider_id = ${providerId}
    `;

    // Fetch CardBear discounts once as a trigger for GCX
    let discounts: any[] = [];
    try {
      const resCb = await fetch("https://www.cardbear.com/api/json.php", {
        headers: { "user-agent": "Mozilla/5.0 (compatible; CardbayBot/1.0)" },
      });
      if (!resCb.ok) {
        console.error(
          `GCX cron: failed to fetch CardBear API: ${resCb.status}`
        );
        return;
      }
      const data = (await resCb.json()) as { discounts?: unknown };
      const rawDiscounts = (data as any).discounts;
      discounts = Array.isArray(rawDiscounts) ? rawDiscounts : [];
    } catch (err: any) {
      console.error(
        "GCX cron: error fetching CardBear API:",
        err?.message || err
      );
      return;
    }

    // Cache GCX responses per slug to avoid duplicate hits
    const gcxCache = new Map<string, any>();

    let updated = 0;
    const brandDiscounts = new Map<
      string,
      { maxDiscount: number; inStock: boolean }
    >();

    // Optional safety cap on GCX subrequests per run; high enough that in
    // practice we cover all brands when running from GitHub Actions / Node.
    const MAX_GCX_QUERIES = 5000;
    let gcxQueryCount = 0;

    for (const d of discounts) {
      const id = String(d.id ?? "").trim();
      if (!id) continue;

      const reseller = String(d.highestDiscountReseller ?? "").toLowerCase();
      const isGcx = reseller === "raise" || reseller === "raisecashback";
      if (!isGcx) continue;

      const mapping = byExternalId.get(id);
      if (!mapping) {
        // We don't have a GCX product for this CardBear id; skip.
        continue;
      }

      const { brandId, productUrl } = mapping;

      // Derive slug from our stored GCX product_url, e.g.
      // https://gcx.raise.com/buy-domino-s-gift-cards
      const m = productUrl.match(/\/buy-([^/?#]+?)-gift-cards/i);
      if (!m) continue;
      const slug = m[1];
      if (!slug) continue;

      let gcxData: any;
      if (gcxCache.has(slug)) {
        gcxData = gcxCache.get(slug);
      } else {
        if (gcxQueryCount >= MAX_GCX_QUERIES) {
          console.warn(
            `GCX cron: reached max query limit (${MAX_GCX_QUERIES}) for this run; remaining brands will be skipped.`
          );
          break;
        }
        try {
          const url = `https://gcx.raise.com/query?type=paths&keywords=${encodeURIComponent(
            slug
          )}`;
          const res = await fetch(url, {
            headers: {
              "user-agent": "Mozilla/5.0 (compatible; CardbayBot/1.0)",
              accept: "application/json, text/plain, */*",
            },
          });
          gcxQueryCount += 1;
          if (!res.ok) {
            console.error(
              `GCX cron: query failed for slug=${slug} status=${res.status}`
            );
            continue;
          }
          gcxData = await res.json();
          gcxCache.set(slug, gcxData);
        } catch (err: any) {
          console.error(
            `GCX cron: error querying GCX for slug=${slug}:`,
            err?.message || err
          );
          continue;
        }
      }

      if (!gcxData) continue;

      const savings = Number(gcxData.savings ?? 0) || 0;
      const quantity = Number(gcxData.quantity_available ?? 0) || 0;
      const available =
        (gcxData.available === true || gcxData.available === "true") &&
        quantity > 0 &&
        savings > 0;

      const maxDiscountPercent = Math.max(0, savings);
      const inStock = available;
      const prev = brandDiscounts.get(brandId) ?? {
        maxDiscount: 0,
        inStock: false,
      };
      brandDiscounts.set(brandId, {
        maxDiscount: Math.max(prev.maxDiscount, maxDiscountPercent),
        inStock: prev.inStock || inStock,
      });

      // Ensure stored URL has UTM tracking
      const baseGcxUrl = productUrl.split("?")[0];
      const trackedGcxUrl = withUtm(baseGcxUrl, slug.replace(/-/g, " "));

      await sql/* sql */ `
        update provider_brand_products
        set
          is_active = ${inStock},
          last_seen_at = ${nowTs},
          last_checked_at = ${nowTs},
          product_url = ${trackedGcxUrl}
        where provider_id = ${providerId}
          and brand_id = ${brandId}
      `;

      updated += 1;
    }

    for (const [brandId, agg] of brandDiscounts.entries()) {
      await sql/* sql */ `
        insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
        values (${providerId}, ${brandId}, ${agg.maxDiscount}, ${agg.inStock}, ${nowTs})
        on conflict (provider_id, brand_id)
        do update set
          max_discount_percent = excluded.max_discount_percent,
          in_stock = excluded.in_stock,
          fetched_at = excluded.fetched_at
      `;
    }

    // History snapshot for GCX
    await sql/* sql */ `
      insert into provider_brand_discount_history (
        provider_id,
        brand_id,
        max_discount_percent,
        in_stock,
        observed_at
      )
      select
        pbd.provider_id,
        pbd.brand_id,
        pbd.max_discount_percent,
        pbd.in_stock,
        pbd.fetched_at
      from provider_brand_discounts pbd
      left join lateral (
        select
          max_discount_percent,
          in_stock
        from provider_brand_discount_history h
        where h.provider_id = pbd.provider_id
          and h.brand_id = pbd.brand_id
        order by observed_at desc
        limit 1
      ) last on true
      where pbd.provider_id = ${providerId}
        and (
          last.max_discount_percent is null
          or last.max_discount_percent is distinct from pbd.max_discount_percent
          or last.in_stock is distinct from pbd.in_stock
        )
    `;

    console.log(
      `GCX cron: updated ${updated} brands based on CardBear GCX flags.`
    );
  } catch (err: any) {
    console.error(
      "GCX cron: fatal error in scheduled run:",
      err?.message || err
    );
  }
}

export async function runArbitrageCron(env: CronEnv) {
  const sql = getDb(env);

  const providerSlug = "arbitragecard";
  const providerName = "ArbitrageCard";

  // Ensure provider exists (idempotent)
  await sql/* sql */ `
    insert into providers (name, slug)
    values (${providerName}, ${providerSlug})
    on conflict (slug) do nothing
  `;

  const providerRow = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!providerRow?.[0]?.id) {
    console.error("Failed to resolve provider id for ArbitrageCard");
    return;
  }
  const providerId = providerRow[0].id;

  // Find brands that currently have ArbitrageCard products and a base_domain
  const rows = await sql/* sql */ `
    select distinct b.id as brand_id, b.base_domain
    from brands b
    join provider_brand_products p on p.brand_id = b.id
    where p.provider_id = ${providerId}
      and b.base_domain is not null
  `;

  const nowTs = new Date().toISOString();

  let updated = 0;
  let failures = 0;

  for (const row of rows as any[]) {
    const brandId = row.brand_id as string;
    const baseDomain = String(row.base_domain ?? "").trim();
    if (!baseDomain) continue;

    const url = `https://arbitragecard.com/wp-json/arbitragecard/v1/available-gift-cards?merchant_domain=${encodeURIComponent(
      baseDomain
    )}`;

    let maxDiscountPercent = 0;
    let inStock = false;

    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; CardbayBot/1.0)",
          accept: "application/json, text/plain, */*",
        },
      });

      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      if (!res.ok || (json && json.code === "no_gift_cards")) {
        failures += 1;
        console.warn(
          `Arbitrage cron: no gift cards for brand_id=${brandId} domain=${baseDomain} status=${
            res.status
          } body=${text.slice(0, 200)}`
        );
        maxDiscountPercent = 0;
        inStock = false;
      } else if (json) {
        const avail = Number(json.available ?? 0) || 0;
        const maxDisc = Number(json.max_discount ?? 0) || 0;
        maxDiscountPercent = Math.max(0, maxDisc);
        inStock = avail > 0 && maxDiscountPercent > 0;
      } else {
        // Unexpected non-JSON; treat as failure
        failures += 1;
        console.warn(
          `Arbitrage cron: unexpected response for brand_id=${brandId} domain=${baseDomain} status=${res.status}`
        );
        maxDiscountPercent = 0;
        inStock = false;
      }
    } catch (err: any) {
      failures += 1;
      console.error(
        `Arbitrage cron: error fetching for brand_id=${brandId} domain=${baseDomain}:`,
        err?.message || err
      );
      maxDiscountPercent = 0;
      inStock = false;
    }

    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${maxDiscountPercent}, ${inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;

    // Ensure stored URLs have UTM tracking
    // First, get existing product URLs for this brand to append UTMs
    const arbProducts = await sql/* sql */ `
      select product_url from provider_brand_products
      where provider_id = ${providerId} and brand_id = ${brandId}
        and product_url is not null
        and product_url not like '%utm_source=carddeals%'
      limit 1
    `;
    for (const ap of arbProducts as any[]) {
      const rawUrl = String(ap.product_url ?? "");
      if (rawUrl) {
        const trackedUrl = withUtm(rawUrl.split("?")[0], baseDomain);
        await sql/* sql */ `
          update provider_brand_products
          set product_url = ${trackedUrl}
          where provider_id = ${providerId} and brand_id = ${brandId}
        `;
      }
    }

    await sql/* sql */ `
      update provider_brand_products
      set
        is_active = ${inStock},
        last_seen_at = ${nowTs},
        last_checked_at = ${nowTs}
      where provider_id = ${providerId}
        and brand_id = ${brandId}
    `;

    updated += 1;
  }

  // History snapshot for ArbitrageCard
  await sql/* sql */ `
    insert into provider_brand_discount_history (
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      observed_at
    )
    select
      pbd.provider_id,
      pbd.brand_id,
      pbd.max_discount_percent,
      pbd.in_stock,
      pbd.fetched_at
    from provider_brand_discounts pbd
    left join lateral (
      select
        max_discount_percent,
        in_stock
      from provider_brand_discount_history h
      where h.provider_id = pbd.provider_id
        and h.brand_id = pbd.brand_id
      order by observed_at desc
      limit 1
    ) last on true
    where pbd.provider_id = ${providerId}
      and (
        last.max_discount_percent is null
        or last.max_discount_percent is distinct from pbd.max_discount_percent
        or last.in_stock is distinct from pbd.in_stock
      )
  `;

  console.log(
    `Arbitrage cron: updated ${updated} brands; ${failures} domains reported as missing/errored.`
  );
}

export async function runOfferInventorySnapshotCron(env: CronEnv) {
  const sql = getDb(env);

  try {
    const rows = await sql/* sql */ `
      with snapshot_ts as (
        select date_trunc('hour', now()) as snapshot_at
      ),
      provider_counts as (
        select
          p.id as provider_id,
          count(v.provider_id) as live_offer_count
        from providers p
        left join v_brand_provider_offers v
          on v.provider_id = p.id
         and v.in_stock = true
        where p.status = 'active'
        group by p.id
      )
      insert into offer_inventory_snapshots (snapshot_at, provider_id, live_offer_count)
      select s.snapshot_at, c.provider_id, c.live_offer_count
      from snapshot_ts s, provider_counts c
      on conflict (provider_id, snapshot_at) do update
      set live_offer_count = excluded.live_offer_count
      returning provider_id, live_offer_count
    `;

    const count = Array.isArray(rows) ? rows.length : 0;
    console.log(
      `Offer inventory snapshot cron: upserted ${count} provider rows.`
    );
  } catch (err: any) {
    console.error(
      "Offer inventory snapshot cron: fatal error:",
      err?.message || err
    );
  }
}

type CategoryCronEnv = CronEnv & {
  GOOGLE_SEARCH_API_KEY: string;
  GOOGLE_SEARCH_CX: string;
  ANTHROPIC_API_KEY: string;
};

const CATEGORY_SLUGS = [
  "food-dining",
  "retail-shopping",
  "entertainment",
  "travel-hotels",
  "home-garden",
  "electronics",
  "beauty-wellness",
  "fashion-apparel",
  "sports-fitness",
  "automotive",
  "office-supplies",
  "pet-supplies",
  "books-media",
  "toys-games",
  "other",
] as const;

type GoogleSearchResult = {
  title: string;
  snippet: string;
  link: string;
};

type BrandSearchContext = {
  results: GoogleSearchResult[];
  officialSiteTitle: string | null;
  officialSiteSnippet: string | null;
};

async function searchBrandContext(
  brandName: string,
  domain: string,
  apiKey: string,
  cx: string
): Promise<BrandSearchContext | null> {
  const query = encodeURIComponent(`${brandName} ${domain}`);
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${query}&num=5`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Google Search error: ${res.status}`);
      return null;
    }

    const data: any = await res.json();
    const items = data?.items;

    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const results: GoogleSearchResult[] = items.map((item: any) => ({
      title: String(item.title || "").trim(),
      snippet: String(item.snippet || "").trim(),
      link: String(item.link || "").trim(),
    }));

    // Find official site result
    let officialSiteTitle: string | null = null;
    let officialSiteSnippet: string | null = null;

    for (const item of items) {
      const link = String(item.link || "").toLowerCase();
      if (link.includes(domain.toLowerCase())) {
        officialSiteTitle = String(item.title || "").trim() || null;
        officialSiteSnippet = String(item.snippet || "").trim() || null;
        break;
      }
    }

    return {
      results,
      officialSiteTitle,
      officialSiteSnippet,
    };
  } catch (err: any) {
    console.error(`Google Search error:`, err?.message || err);
    return null;
  }
}

type ClassificationResult = {
  category: string;
  confidence: number;
  description: string;
};

async function classifyWithClaude(
  brandName: string,
  domain: string,
  context: BrandSearchContext,
  apiKey: string
): Promise<ClassificationResult | null> {
  // Build rich context from Google Search results
  const searchContext = context.results
    .slice(0, 5)
    .map((r, i) => `Result ${i + 1}:\n  Title: ${r.title}\n  Snippet: ${r.snippet}\n  URL: ${r.link}`)
    .join("\n\n");

  const officialContext = context.officialSiteTitle || context.officialSiteSnippet
    ? `\nOfficial Site Info:\n  Title: ${context.officialSiteTitle || "N/A"}\n  Description: ${context.officialSiteSnippet || "N/A"}`
    : "";

  const prompt = `You are a brand analyst. Given a brand name, domain, and search results, you must:
1. Write an ORIGINAL 1-2 sentence description of the brand in third person
2. Classify the brand into exactly ONE category
3. Provide your confidence level (0-100)

DESCRIPTION RULES:
- Write in third person (e.g., "Nike is..." not "Get Nike...")
- Be factual and professional, not promotional
- DO NOT copy text from the search results
- DO NOT include "...", "→", marketing slogans, or incomplete sentences
- Start with "[Brand Name] is..." or "[Brand Name] offers..."
- Focus on: what they sell, what industry they're in, what makes them known

Categories:
- food-dining: Restaurants, food delivery, groceries, coffee shops, cafes
- retail-shopping: General merchandise, department stores, marketplaces, discount stores
- entertainment: Movies, music, streaming, gaming, events, tickets
- travel-hotels: Airlines, hotels, vacation rentals, travel booking, cruises
- home-garden: Furniture, home decor, home improvement, gardening, appliances
- electronics: Computers, phones, tech gadgets, electronics stores, software
- beauty-wellness: Cosmetics, skincare, spa, salons, wellness, personal care
- fashion-apparel: Clothing, shoes, accessories, jewelry, watches
- sports-fitness: Athletic gear, gyms, sporting goods, outdoor equipment
- automotive: Auto parts, car services, fuel, dealerships, car rental
- office-supplies: Office equipment, stationery, business supplies, printing
- pet-supplies: Pet food, pet toys, veterinary, pet stores
- books-media: Books, magazines, news, educational content, audiobooks
- toys-games: Toys, board games, hobbies, crafts, collectibles
- other: Only use if brand truly doesn't fit ANY above category

Brand: ${brandName}
Domain: ${domain}
${officialContext}

Search Results:
${searchContext}

EXAMPLE good descriptions:
- "Starbucks is a global coffeehouse chain known for handcrafted espresso drinks, teas, and pastries."
- "Nike is a multinational sportswear company that designs and sells athletic footwear, apparel, and equipment."
- "Home Depot is a home improvement retailer offering tools, building materials, appliances, and services."

Respond in this exact JSON format (no markdown, no code blocks):
{"description": "Your 1-2 sentence brand description here.", "category": "category-slug", "confidence": 85}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Claude API error: ${res.status} - ${text.slice(0, 200)}`);
      return null;
    }

    const data: any = await res.json();
    const response = data?.content?.[0]?.text || "";

    // Parse JSON response
    let parsed: any;
    try {
      // Clean up response in case Claude adds markdown
      const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.error(`Claude returned invalid JSON: ${response.slice(0, 200)}`);
      return null;
    }

    const category = String(parsed.category || "other").toLowerCase().trim();
    const confidence = Number(parsed.confidence) || 0;
    const description = String(parsed.description || "").trim();

    // Validate category slug
    const validCategory = CATEGORY_SLUGS.includes(category as any) ? category : "other";

    return {
      category: validCategory,
      confidence,
      description,
    };
  } catch (err: any) {
    console.error(`Claude API error:`, err?.message || err);
    return null;
  }
}

export async function runBrandCategoryCron(env: CategoryCronEnv) {
  const sql = getDb(env);

  if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_CX) {
    console.error("Brand category cron: GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX are required");
    return;
  }

  if (!env.ANTHROPIC_API_KEY) {
    console.error("Brand category cron: ANTHROPIC_API_KEY is required");
    return;
  }

  // Fetch all brands that need classification (have domain, no category OR no description, active)
  const brands = await sql/* sql */ `
    select id, name, base_domain, description
    from brands
    where base_domain is not null
      and (category_id is null or description is null)
      and status = 'active'
    order by created_at asc
  `;

  if (!brands.length) {
    console.log("Brand category cron: no brands to classify");
    return;
  }

  console.log(`Brand category cron: processing ${brands.length} brands`);

  // Fetch category slug -> id mapping
  const categoryRows = await sql/* sql */ `
    select id, slug from categories
  `;

  const categoryMap = new Map<string, string>();
  for (const row of categoryRows as any[]) {
    categoryMap.set(row.slug as string, row.id as string);
  }

  const CONFIDENCE_THRESHOLD = 80;

  let processed = 0;
  let skippedLowConfidence = 0;
  let errors = 0;

  for (const brand of brands as any[]) {
    const brandId = brand.id as string;
    const brandName = brand.name as string;
    const domain = String(brand.base_domain ?? "").trim();

    if (!domain) continue;

    // Rate limit: 200ms delay between requests (Google has rate limits)
    if (processed > 0 || errors > 0 || skippedLowConfidence > 0) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    try {
      // Step 1: Get rich context from Google Search
      const context = await searchBrandContext(
        brandName,
        domain,
        env.GOOGLE_SEARCH_API_KEY,
        env.GOOGLE_SEARCH_CX
      );

      if (!context || context.results.length === 0) {
        console.warn(`Brand category cron: no search results for "${brandName}" (${domain})`);
        errors += 1;
        continue;
      }

      // Step 2: Classify and generate description using Claude
      const result = await classifyWithClaude(
        brandName,
        domain,
        context,
        env.ANTHROPIC_API_KEY
      );

      if (!result) {
        console.error(`Brand category cron: Claude failed for "${brandName}"`);
        errors += 1;
        continue;
      }

      // Step 3: Check confidence threshold
      if (result.confidence < CONFIDENCE_THRESHOLD) {
        console.warn(
          `Brand category cron: LOW CONFIDENCE (${result.confidence}%) for "${brandName}" → ${result.category} | Skipping`
        );
        skippedLowConfidence += 1;
        continue;
      }

      const categoryId = categoryMap.get(result.category) || categoryMap.get("other");

      if (!categoryId) {
        console.error(`Brand category cron: could not find category for slug ${result.category}`);
        errors += 1;
        continue;
      }

      // Step 4: Update brand with description and category
      await sql/* sql */ `
        update brands
        set
          description = ${result.description || null},
          category_id = ${categoryId},
          updated_at = now()
        where id = ${brandId}
      `;

      console.log(
        `Brand category cron: "${brandName}" → ${result.category} (${result.confidence}%) | "${result.description.slice(0, 50)}..."`
      );

      processed += 1;
    } catch (err: any) {
      console.error(
        `Brand category cron: error processing ${brandName} (${domain}):`,
        err?.message || err
      );
      errors += 1;
    }
  }

  console.log(
    `Brand category cron: processed ${processed} brands, ${skippedLowConfidence} skipped (low confidence), ${errors} errors`
  );
}

// ---------------------------------------------------------------------------
// Sam's Club cron
// ---------------------------------------------------------------------------
//
// Pulls Sam's Club's gift card catalog from the Rakuten Advertising Product
// Search API, matches each product to one of our existing brands using STRICT
// normalized name/alias lookup (no substring or fuzzy matching — that's what
// caused Applebee's to land on the Apple brand page in the original import),
// and writes the single highest-discount offer per brand. Anything that does
// not produce an exact normalized match is dropped.

/**
 * Strip Sam's-Club-isms ("Multi-Pack", "$50", "Email Delivery", etc.) from a
 * product title to leave just the brand name. Returns lowercase, may include
 * spaces and apostrophes — caller should pass the result through
 * normalizeBrandKey() before lookup.
 */
function extractSamsClubBrandText(title: string): string {
  let t = title.toLowerCase();
  // Quantity / multi-pack patterns: "3 x $25", "2x$15", "3 x 25"
  t = t.replace(/\b\d+\s*[x×]\s*\$?\d+(?:\.\d+)?\b/g, " ");
  // Dollar amounts: "$50", "$100.00"
  t = t.replace(/\$\s*\d+(?:\.\d+)?/g, " ");
  // Standalone integer face values left after the $ stripping
  t = t.replace(/\b\d{2,4}\b/g, " ");
  // Marketing/format noise
  t = t.replace(/\bemail delivery\b/g, " ");
  t = t.replace(/\bdigital delivery\b/g, " ");
  t = t.replace(/\bphysical (?:gift )?card\b/g, " ");
  t = t.replace(/\bmulti[\s-]?pack\b/g, " ");
  t = t.replace(/\bgift cards?\b/g, " ");
  t = t.replace(/\begift\b/g, " ");
  t = t.replace(/\bvalue add\b/g, " ");
  t = t.replace(/\bvalue\b/g, " ");
  t = t.replace(/\bbonus\b/g, " ");
  t = t.replace(/\bnext gen\b/g, " ");
  // Punctuation
  t = t.replace(/[:,\-\(\)\/]+/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

/** Normalize a name so "Applebee's", "applebees", and "Apple Bee's" collapse to one key. */
function normalizeBrandKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull a face value (e.g. 50 from "Olive Garden $50 Gift Card") from a Sam's Club product title. */
function extractSamsClubFaceValue(title: string): number | null {
  const dollarMatch = title.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (dollarMatch) {
    const v = parseFloat(dollarMatch[1]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  // Fallback for titles like "Sam's Club Fuel Up Gift Card: - 75"
  const numMatch = title.match(/[\s:\-]+(\d{2,4})(?:[\s:]|$)/);
  if (numMatch) {
    const v = parseFloat(numMatch[1]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  return null;
}

async function fetchSamsClubAccessToken(env: SamsClubCronEnv): Promise<string> {
  const basicAuth = Buffer.from(
    `${env.RAKUTEN_CLIENT_ID}:${env.RAKUTEN_CLIENT_SECRET}`
  ).toString("base64");
  const resp = await fetch(RAKUTEN_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=client_credentials&scope=${env.RAKUTEN_SID}`,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Sam's Club cron: token fetch failed: ${resp.status} ${body}`);
  }
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Sam's Club cron: no access_token in response");
  }
  return data.access_token;
}

type SamsClubProduct = {
  sku: string;
  productName: string;
  productUrl: string;
  imageUrl: string;
  price: number;
  saleprice: number;
};

async function fetchSamsClubProductsPage(
  accessToken: string,
  pageNumber: number
): Promise<{ products: SamsClubProduct[]; totalPages: number }> {
  const url = `${RAKUTEN_PRODUCT_SEARCH_URL}?keyword=gift+card&mid=${SAMS_CLUB_MID}&max=100&pagenumber=${pageNumber}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(
      `Sam's Club cron: product fetch page ${pageNumber} failed: ${resp.status}`
    );
  }
  const xml = await resp.text();
  const $ = loadHtml(xml, { xmlMode: true });
  const totalPages = parseInt($("TotalPages").text() || "1", 10) || 1;
  const products: SamsClubProduct[] = [];
  $("item").each((_idx, el) => {
    const $item = $(el);
    products.push({
      sku: $item.find("sku").text().trim(),
      productName: $item.find("productname").text().trim(),
      productUrl: $item.find("linkurl").text().trim(),
      imageUrl: $item.find("imageurl").text().trim(),
      price: parseFloat($item.find("price").text() || "0") || 0,
      saleprice: parseFloat($item.find("saleprice").text() || "0") || 0,
    });
  });
  return { products, totalPages };
}

export async function runSamsClubCron(env: SamsClubCronEnv) {
  const sql = getDb(env);

  // 1) Ensure provider exists
  await sql/* sql */ `
    insert into providers (name, slug)
    values (${SAMS_CLUB_PROVIDER_NAME}, ${SAMS_CLUB_PROVIDER_SLUG})
    on conflict (slug) do nothing
  `;
  const providerRow = await sql/* sql */ `
    select id from providers where slug = ${SAMS_CLUB_PROVIDER_SLUG} limit 1
  `;
  if (!providerRow?.[0]?.id) {
    console.error("Sam's Club cron: failed to resolve provider id");
    return;
  }
  const providerId = providerRow[0].id as string;

  // 2) Build a strict brand lookup index from active brands + aliases.
  //    Key = normalized lowercased token sequence. Values are brand_ids.
  //    Strict equality only — never substring/fuzzy. Drop unmatched products.
  const brandRows = await sql/* sql */ `
    select id, name, slug from brands where status = 'active'
  `;
  const aliasRows = await sql/* sql */ `
    select brand_id, alias from brand_aliases
  `;

  const brandIndex = new Map<string, string>();
  for (const b of brandRows as any[]) {
    const id = b.id as string;
    const nameKey = normalizeBrandKey(b.name as string);
    const slugKey = normalizeBrandKey(b.slug as string);
    if (nameKey) brandIndex.set(nameKey, id);
    if (slugKey && !brandIndex.has(slugKey)) brandIndex.set(slugKey, id);
  }
  for (const a of aliasRows as any[]) {
    const aliasKey = normalizeBrandKey(a.alias as string);
    if (aliasKey && !brandIndex.has(aliasKey)) {
      brandIndex.set(aliasKey, a.brand_id as string);
    }
  }
  console.log(`Sam's Club cron: brand index has ${brandIndex.size} keys`);

  // 3) Mark all current Sam's Club state out of stock; the upsert loop will
  //    flip back any brand we re-confirm.
  const nowTs = new Date().toISOString();
  await sql/* sql */ `
    update provider_brand_discounts
    set in_stock = false, fetched_at = ${nowTs}
    where provider_id = ${providerId}
  `;
  await sql/* sql */ `
    update provider_brand_products
    set is_active = false, last_checked_at = ${nowTs}
    where provider_id = ${providerId}
  `;

  // 4) Fetch all pages, accumulate the highest-discount offer per brand.
  const accessToken = await fetchSamsClubAccessToken(env);

  type BestOffer = {
    brandId: string;
    sku: string;
    productName: string;
    productUrl: string;
    discount: number;
  };
  const bestPerBrand = new Map<string, BestOffer>();

  let totalProducts = 0;
  let matchedProducts = 0;
  let droppedNoBrand = 0;
  let droppedNoDiscount = 0;
  let pageNumber = 1;
  let totalPages = 1;

  while (pageNumber <= totalPages && pageNumber <= SAMS_CLUB_MAX_PAGES) {
    const { products, totalPages: tp } = await fetchSamsClubProductsPage(
      accessToken,
      pageNumber
    );
    if (pageNumber === 1) totalPages = tp;
    totalProducts += products.length;

    for (const p of products) {
      // Pick current selling price. Sam's Club mostly populates <price>; when
      // both are present, <saleprice> is sometimes inflated, so take the lower.
      const currentPrice =
        p.saleprice > 0 && p.saleprice < p.price ? p.saleprice : p.price;
      if (currentPrice <= 0) {
        droppedNoDiscount++;
        continue;
      }

      const faceValue = extractSamsClubFaceValue(p.productName);
      if (!faceValue || currentPrice >= faceValue) {
        droppedNoDiscount++;
        continue;
      }

      const discount = ((faceValue - currentPrice) / faceValue) * 100;
      if (discount <= 0) {
        droppedNoDiscount++;
        continue;
      }

      const brandText = extractSamsClubBrandText(p.productName);
      const brandKey = normalizeBrandKey(brandText);
      const brandId = brandKey ? brandIndex.get(brandKey) : null;
      if (!brandId) {
        droppedNoBrand++;
        continue;
      }

      matchedProducts++;
      const existing = bestPerBrand.get(brandId);
      if (!existing || discount > existing.discount) {
        bestPerBrand.set(brandId, {
          brandId,
          sku: p.sku,
          productName: p.productName,
          productUrl: p.productUrl,
          discount: Math.round(discount * 100) / 100,
        });
      }
    }

    pageNumber++;
  }

  console.log(
    `Sam's Club cron: scanned ${totalProducts} products across ${pageNumber - 1} pages; ` +
      `matched ${matchedProducts}, brands chosen ${bestPerBrand.size}, ` +
      `dropped ${droppedNoBrand} unmatched, ${droppedNoDiscount} no-discount`
  );

  // 5) Persist the chosen offers. One product per brand for samsclub: replace
  //    any older SKU rows for the same brand with the current best.
  let upserted = 0;
  for (const offer of bestPerBrand.values()) {
    // Drop any stale Sam's Club products for this brand first (different SKUs)
    await sql/* sql */ `
      delete from provider_brand_products
      where provider_id = ${providerId}
        and brand_id = ${offer.brandId}
        and (variant <> 'online' or coalesce(product_external_id, '') <> ${offer.sku})
    `;

    await sql/* sql */ `
      insert into provider_brand_products
        (provider_id, brand_id, variant, product_external_id, product_url,
         is_active, last_seen_at, last_checked_at, discount_percent)
      values
        (${providerId}, ${offer.brandId}, 'online', ${offer.sku}, ${offer.productUrl},
         true, ${nowTs}, ${nowTs}, ${offer.discount})
      on conflict do nothing
    `;
    await sql/* sql */ `
      update provider_brand_products
      set product_url = ${offer.productUrl},
          is_active = true,
          last_seen_at = ${nowTs},
          last_checked_at = ${nowTs},
          discount_percent = ${offer.discount}
      where provider_id = ${providerId}
        and brand_id = ${offer.brandId}
        and variant = 'online'
        and coalesce(product_external_id, '') = ${offer.sku}
    `;

    await sql/* sql */ `
      insert into provider_brand_discounts
        (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values
        (${providerId}, ${offer.brandId}, ${offer.discount}, true, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = true,
        fetched_at = ${nowTs}
    `;
    upserted++;
  }

  // 6) Append history snapshot only for brands whose state changed
  await sql/* sql */ `
    insert into provider_brand_discount_history (
      provider_id, brand_id, max_discount_percent, in_stock, observed_at
    )
    select pbd.provider_id, pbd.brand_id, pbd.max_discount_percent, pbd.in_stock, pbd.fetched_at
    from provider_brand_discounts pbd
    left join lateral (
      select max_discount_percent, in_stock
      from provider_brand_discount_history h
      where h.provider_id = pbd.provider_id and h.brand_id = pbd.brand_id
      order by observed_at desc
      limit 1
    ) last on true
    where pbd.provider_id = ${providerId}
      and (
        last.max_discount_percent is null
        or last.max_discount_percent is distinct from pbd.max_discount_percent
        or last.in_stock is distinct from pbd.in_stock
      )
  `;

  console.log(`Sam's Club cron: upserted ${upserted} brand offers.`);
}
