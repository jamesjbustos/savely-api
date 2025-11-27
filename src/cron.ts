import { getDb } from "./db.ts";
import { load as loadHtml } from "cheerio";
import {
  normalizeBrandName,
  slugifyBrandName,
  mapVariantFromStrings,
} from "./brandUtils.ts";

type CronEnv = {
  DATABASE_URL: string;
};

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
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
  });

  if (!res.ok) {
    console.error(`CardCenter cron: failed to fetch brands: ${res.status}`);
    return;
  }

  const data: any = await res.json();
  const items: any[] = Array.isArray(data?.items) ? data.items : [];

  console.log(`CardCenter cron: fetched ${items.length} brands from API`);

  const nowTs = new Date().toISOString();

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

    const maxDiscountPercent = Math.max(0, high * 100);

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
          values (${brandId}, ${providerBrandName})
          on conflict do nothing
        `;
      }
    }

    const inStock = true; // items with discounts are treated as available

    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${maxDiscountPercent}, ${inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;

    const productUrl = `https://cardcenter.cc/shop/gift-cards/${providerBrandSlug}`;

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
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      fetched_at
    from provider_brand_discounts
    where provider_id = ${providerId}
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
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
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
    const q = String(item?.q ?? "").trim();

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
          values (${brandId}, ${title})
          on conflict do nothing
        `;
      }
    }

    // CardDepot discount is already a percentage value
    const maxDiscountPercent = Math.max(0, discount);

    const utmCampaign = encodeURIComponent(q || title || slug);
    const productUrl = `https://carddepot.com/brands/${slug}?utm_source=savely&utm_medium=partner&utm_campaign=${utmCampaign}`;

    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${maxDiscountPercent}, ${isStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;

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
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      fetched_at
    from provider_brand_discounts
    where provider_id = ${providerId}
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
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
  });

  if (!res.ok) {
    console.error(`CardCookie cron: failed to fetch homepage: ${res.status}`);
    return;
  }

  const html = await res.text();
  const $ = loadHtml(html);

  const nowTs = new Date().toISOString();

  const anchors = $(".gift-card-grid a.giftCard-link");
  console.log(`CardCookie cron: found ${anchors.length} items on homepage`);

  // 1) Pessimistically mark everything out of stock / inactive
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
    const productUrl = `https://cardcookie.com/${path}`;

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
          values (${brandId}, ${providerBrandName})
          on conflict do nothing
        `;
      }
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
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      fetched_at
    from provider_brand_discounts
    where provider_id = ${providerId}
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

    // Fetch CardBear discounts once as a trigger for GCX
    let discounts: any[] = [];
    try {
      const resCb = await fetch("https://www.cardbear.com/api/json.php", {
        headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
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

    const nowTs = new Date().toISOString();

    // Cache GCX responses per slug to avoid duplicate hits
    const gcxCache = new Map<string, any>();

    let updated = 0;

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
              "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)",
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

      await sql/* sql */ `
        insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
        values (${providerId}, ${brandId}, ${maxDiscountPercent}, ${inStock}, ${nowTs})
        on conflict (provider_id, brand_id)
        do update set
          max_discount_percent = excluded.max_discount_percent,
          in_stock = excluded.in_stock,
          fetched_at = excluded.fetched_at
      `;

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
        provider_id,
        brand_id,
        max_discount_percent,
        in_stock,
        fetched_at
      from provider_brand_discounts
      where provider_id = ${providerId}
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
          "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)",
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
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      fetched_at
    from provider_brand_discounts
    where provider_id = ${providerId}
  `;

  console.log(
    `Arbitrage cron: updated ${updated} brands; ${failures} domains reported as missing/errored.`
  );
}
