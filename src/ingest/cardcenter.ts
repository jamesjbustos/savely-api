// src/ingest/cardcenter.ts
import { neon } from "@neondatabase/serverless";
import { upsertBrand } from "./brand";
import { ensureBrandAliasIndexes } from "../db";

type Env = { DATABASE_URL: string };

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json, text/plain, */*",
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Fetch ${r.status} ${url}`);
  return r.json() as Promise<T>;
}

async function upsertProvider(sql: any) {
  const rows = await sql/* sql */ `
    INSERT INTO providers (name, slug)
    VALUES ('CardCenter', 'cardcenter')
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return rows[0].id as string;
}

// brand upsert now shared via ./brand

async function upsertProviderBrandUrl(
  sql: any,
  providerId: string,
  brandId: string,
  url: string
) {
  // CardCenter doesn’t have in-store vs online split → use 'online'
  await sql/* sql */ `
    INSERT INTO provider_brand_urls (provider_id, brand_id, variant, product_url, is_active, fetched_at)
    VALUES (${providerId}, ${brandId}, 'online', ${url}, true, now())
    ON CONFLICT (provider_id, brand_id, variant)
    DO UPDATE SET product_url = EXCLUDED.product_url, is_active = true, fetched_at = now();
  `;
}

async function upsertBrandDiscount(
  sql: any,
  providerId: string,
  brandId: string,
  url: string,
  maxPct: number
) {
  await sql/* sql */ `
    INSERT INTO brand_discounts (provider_id, brand_id, product_url, max_discount_percent, fetched_at)
    VALUES (${providerId}, ${brandId}, ${url}, ${maxPct}, now())
    ON CONFLICT (provider_id, brand_id)
    DO UPDATE SET product_url = EXCLUDED.product_url,
                  max_discount_percent = EXCLUDED.max_discount_percent,
                  fetched_at = EXCLUDED.fetched_at;
  `;
}

/**
 * Strategy:
 * 1) GET https://cardcenter.cc/Api/Shop/Brands → authoritative list of brands, slugs, and {discounts: {high}}
 * 2) For each brand: build product URL: https://cardcenter.cc/shop/gift-cards/{slug}
 * 3) Write provider_brand_urls (variant='online') and brand_discounts (use discounts.high * 100)
 *    - Keep it simple: “max discount percent” = (high * 100), no fees math.
 *    - Canonical/primary link should be read via the view v_provider_brand_primary_url (no extra table).
 */
export async function harvestCardCenter(env: Env) {
  const sql = neon(env.DATABASE_URL);
  await ensureBrandAliasIndexes(sql);
  const providerId = await upsertProvider(sql);

  type BrandsResp = {
    items: Array<{
      brand: { name: string; slug: string; id: number; type: string };
      discounts?: { low?: number; high?: number };
      values?: { low?: number; high?: number };
    }>;
  };

  const listUrl = "https://cardcenter.cc/Api/Shop/Brands";
  const data = await fetchJson<BrandsResp>(listUrl);

  let processed = 0;

  for (const it of data.items ?? []) {
    const brandName = (it.brand?.name ?? "").trim();
    const brandSlug = (it.brand?.slug ?? "").trim();
    if (!brandName || !brandSlug) continue;

    // Build product URL from slug (stable pattern)
    const productUrl = `https://cardcenter.cc/shop/gift-cards/${brandSlug}`;

    // Convert high discount (fraction) to percent; e.g., 0.0925 → 9.3
    const high = it.discounts?.high;
    const pct = typeof high === "number" ? Math.round(high * 1000) / 10 : null;

    const brandId = await upsertBrand(sql, brandName);
    await upsertProviderBrandUrl(sql, providerId, brandId, productUrl);

    if (pct != null && pct > 0) {
      await upsertBrandDiscount(sql, providerId, brandId, productUrl, pct);
    }

    processed++;
  }

  return { provider: "cardcenter", processed };
}
