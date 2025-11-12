import { neon } from "@neondatabase/serverless";
import { extractXmlLocs, fetchText, getH1, cleanBrand } from "./util";
import { upsertBrand } from "./brand";
import { ensureBrandAliasIndexes } from "../db";

type Env = { DATABASE_URL: string };

async function upsertProvider(sql: any) {
  const rows = await sql/* sql */ `
    INSERT INTO providers (name, slug)
    VALUES ('ArbitrageCard', 'arbitragecard')
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return rows[0].id as string;
}

function extractProductUrlsFromSitemap(xml: string): string[] {
  const urls = extractXmlLocs(xml);
  const out = urls.filter((u) =>
    /^https?:\/\/arbitragecard\.com\/product\/[a-z0-9-]+\/?$/i.test(u)
  );
  // normalize trailing slashes and dedupe
  return [...new Set(out.map((u) => u.replace(/\/+$/, "")))];
}

function extractBrandFromHtml(html: string): string {
  // Prefer Elementor heading used on product pages
  const m =
    html.match(
      /<p[^>]*class=["'][^"']*\belementor-heading-title\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    ) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const raw = m ? m[1].replace(/<[^>]*>/g, "").trim() : "";
  return cleanBrand(raw);
}

function extractMaxDiscount(html: string): number | null {
  // Collect all discount cells and compute max; ex: <td class="custom-wsv-td-discount" ...>8.00%</td>
  const re =
    /<td[^>]*class=["'][^"']*\bcustom-wsv-td-discount\b[^"']*["'][^>]*>\s*([0-9]{1,2}(?:\.[0-9]{1,2})?)\s*%/gi;
  let m: RegExpExecArray | null;
  let max: number | null = null;
  while ((m = re.exec(html))) {
    const val = parseFloat(m[1]);
    if (!Number.isNaN(val)) {
      max = max == null ? val : Math.max(max, val);
    }
  }
  return max;
}

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
    DO UPDATE SET product_url = EXCLUDED.product_url, is_active = true, fetched_at = now();
  `;
}

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

export async function harvestArbitrageCard(env: Env) {
  const sql = neon(env.DATABASE_URL);
  await ensureBrandAliasIndexes(sql);
  const providerId = await upsertProvider(sql);

  const sm = await fetchText("https://arbitragecard.com/product-sitemap.xml");
  const urls = extractProductUrlsFromSitemap(sm);

  const concurrency = 6;
  const queue = [...urls];
  let processed = 0;

  const workers = Array.from({ length: concurrency }, () =>
    (async () => {
      while (queue.length) {
        const url = queue.pop()!;
        try {
          const html = await fetchText(url);
          const brandName = extractBrandFromHtml(html);
          if (!brandName) continue;
          const pct = extractMaxDiscount(html);

          const brandId = await upsertBrand(sql, brandName);
          await upsertProviderBrandUrl(sql, providerId, brandId, url);
          if (pct != null && pct > 0) {
            await upsertBrandDiscount(sql, providerId, brandId, url, Math.round(pct * 10) / 10);
          }
          processed++;
        } catch {
          // swallow and continue
        }
      }
    })()
  );

  await Promise.all(workers);
  return { provider: "arbitragecard", crawled_urls: urls.length, processed };
}


