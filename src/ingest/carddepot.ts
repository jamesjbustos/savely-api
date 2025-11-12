import { neon } from "@neondatabase/serverless";
import {
  extractXmlLocs,
  fetchText,
  getH1,
  cleanBrand,
  extractPercent,
} from "./util";
import { upsertBrand } from "./brand";
import { ensureBrandAliasIndexes } from "../db";

type Env = { DATABASE_URL: string };

/** JSON fetcher with a browser-y UA if you need it later */
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
    VALUES ('CardDepot', 'carddepot')
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return rows[0].id as string;
}

/** Single row per provider×brand×variant (always 'online' here) */
async function upsertProviderBrandUrl(
  sql: any,
  providerId: string,
  brandId: string,
  url: string
) {
  await sql/* sql */ `
    INSERT INTO provider_brand_urls (provider_id, brand_id, variant, product_url, is_active, fetched_at)
    VALUES (${providerId}, ${brandId}, 'online', ${url}, true, now())
    ON CONFLICT (provider_id, brand_id, variant)
    DO UPDATE SET product_url = EXCLUDED.product_url,
                  is_active = true,
                  fetched_at = now();
  `;
}

/** Keep one max discount snapshot per provider×brand (latest wins) */
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

/** CardDepot specific helpers */
function isProductUrl(u: string) {
  // /brands/... (covers both “discount-...” and simple slugs)
  return /^https?:\/\/carddepot\.com\/brands\/[a-z0-9-]+/i.test(u);
}

function isOutOfStock(html: string) {
  const h = html.toLowerCase();
  return (
    h.includes("out of stock") ||
    (h.includes("<h3") &&
      h.includes("sorry!") &&
      h.includes("no available gift cards"))
  );
}

export async function harvestCardDepot(env: Env) {
  const sql = neon(env.DATABASE_URL);
  await ensureBrandAliasIndexes(sql);
  const providerId = await upsertProvider(sql);

  // 1) Pull sitemap, keep only brand product pages
  const sm = await fetchText("https://carddepot.com/sitemap.xml");
  const urls = extractXmlLocs(sm).filter(isProductUrl);

  const concurrency = 6;
  const queue = [...urls];
  let processed = 0;

  const workers = Array.from({ length: concurrency }, () =>
    (async () => {
      while (queue.length) {
        const url = queue.pop()!;
        try {
          const html = await fetchText(url);

          // 2) Extract brand name from <h1> and normalize
          const raw = getH1(html);
          const brandName = cleanBrand(raw);
          if (!brandName) continue;

          // 3) Detect % off if present
          const pct = extractPercent(html); // looks for “7%” etc.

          // 4) Skip discount write if explicitly out of stock; still keep URL mapping
          const out = isOutOfStock(html);

          // 5) Alias-aware brand UPSERT, then map provider URL
          const brandId = await upsertBrand(sql, brandName);
          await upsertProviderBrandUrl(sql, providerId, brandId, url);

          // 6) Best discount snapshot (only if in-stock-ish and pct>0)
          if (!out && pct != null && pct > 0) {
            await upsertBrandDiscount(sql, providerId, brandId, url, pct);
          }

          processed++;
        } catch {
          // swallow and continue
        }
      }
    })()
  );

  await Promise.all(workers);
  return { provider: "carddepot", crawled_urls: urls.length, processed };
}
