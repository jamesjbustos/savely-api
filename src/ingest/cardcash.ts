// src/ingest/cardcash.ts
import { neon } from "@neondatabase/serverless";
import {
  extractXmlLocs,
  fetchText,
  getH1,
  looksLike404,
  cleanBrand,
  extractPercent,
  detectVariantFromUrl,
} from "./util";
import { upsertBrand } from "./brand";
import { ensureBrandAliasIndexes } from "../db";

type Env = { DATABASE_URL: string };

async function upsertProvider(sql: any) {
  const rows = await sql/* sql */ `
    INSERT INTO providers (name, slug)
    VALUES ('CardCash', 'cardcash')
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return rows[0].id as string;
}

async function upsertProviderBrandUrl(
  sql: any,
  providerId: string,
  brandId: string,
  variant: string,
  url: string
) {
  await sql/* sql */ `
    INSERT INTO provider_brand_urls (provider_id, brand_id, variant, product_url)
    VALUES (${providerId}, ${brandId}, ${variant}, ${url})
    ON CONFLICT (provider_id, brand_id, variant)
    DO UPDATE SET product_url = EXCLUDED.product_url, is_active = true, fetched_at = now();
  `;
}

async function upsertCanonicalMap(
  sql: any,
  providerId: string,
  brandId: string,
  variant: string,
  url: string
) {
  // keep provider_brand_map as the single canonical URL → prefer ONLINE
  const existing = await sql/* sql */ `
    SELECT product_url FROM provider_brand_map
    WHERE provider_id = ${providerId} AND brand_id = ${brandId}
    LIMIT 1
  `;

  const isInStore = variant === "in_store_only";

  if (existing.length === 0) {
    // first time → just set whatever we have
    await sql/* sql */ `
      INSERT INTO provider_brand_map (provider_id, brand_id, product_url, status)
      VALUES (${providerId}, ${brandId}, ${url}, 'active')
      ON CONFLICT (provider_id, brand_id)
      DO UPDATE SET product_url = EXCLUDED.product_url, status='active';
    `;
    return;
  }

  const currentUrl: string = existing[0].product_url;
  const currentVariant = detectVariantFromUrl(currentUrl);
  const currentIsInStore = currentVariant === "in_store_only";

  // If current is ONLINE and new is IN-STORE → keep current (do nothing)
  if (!currentIsInStore && isInStore) return;

  // If current is IN-STORE and new is ONLINE → upgrade to ONLINE
  if (currentIsInStore && !isInStore) {
    await sql/* sql */ `
      UPDATE provider_brand_map
      SET product_url = ${url}, status='active'
      WHERE provider_id = ${providerId} AND brand_id = ${brandId};
    `;
    return;
  }

  // Same type: allow update (idempotent)
  if (currentUrl !== url) {
    await sql/* sql */ `
      UPDATE provider_brand_map
      SET product_url = ${url}, status='active'
      WHERE provider_id = ${providerId} AND brand_id = ${brandId};
    `;
  }
}

// unchanged
async function upsertBrandDiscount(
  sql: any,
  providerId: string,
  brandId: string,
  url: string,
  pct: number
) {
  await sql/* sql */ `
    INSERT INTO brand_discounts (provider_id, brand_id, product_url, max_discount_percent, fetched_at)
    VALUES (${providerId}, ${brandId}, ${url}, ${pct}, now())
    ON CONFLICT (provider_id, brand_id)
    DO UPDATE SET product_url = EXCLUDED.product_url,
                  max_discount_percent = EXCLUDED.max_discount_percent,
                  fetched_at = EXCLUDED.fetched_at;
  `;
}

export async function harvestCardCash(env: { DATABASE_URL: string }) {
  const sql = neon(env.DATABASE_URL);
  await ensureBrandAliasIndexes(sql);
  const providerId = await upsertProvider(sql);

  const sm = await fetchText("https://www.cardcash.com/sitemap.xml");
  const urls = extractXmlLocs(sm).filter((u) =>
    /\/buy-gift-cards\/discount-.*-cards\/?$/i.test(u)
  );

  const concurrency = 6;
  const queue = [...urls];

  const workers = Array.from({ length: concurrency }, () =>
    (async () => {
      while (queue.length) {
        const url = queue.pop()!;
        try {
          const html = await fetchText(url);
          if (looksLike404(html)) continue;

          const raw = getH1(html);
          const brandName = cleanBrand(raw);
          if (!brandName) continue;

          const pct = extractPercent(html);
          const brandId = await upsertBrand(sql, brandName);

          const variant = detectVariantFromUrl(url);
          // 1) store every variant
          await upsertProviderBrandUrl(sql, providerId, brandId, variant, url);
          // 2) set canonical (online wins)
          await upsertCanonicalMap(sql, providerId, brandId, variant, url);
          // 3) discount (single best per provider×brand is fine)
          if (pct != null && pct > 0) {
            await upsertBrandDiscount(sql, providerId, brandId, url, pct);
          }
        } catch {
          // swallow + continue
        }
      }
    })()
  );

  await Promise.all(workers);

  return { provider: "cardcash", crawled_urls: urls.length };
}
