// src/ingest/cardcookie.ts
import { neon } from "@neondatabase/serverless";
import { fetchText, getH1, decodeHtml, toSlug } from "./util";

type Env = { DATABASE_URL: string };

function extractCardCookieUrls(xml: string): string[] {
  // Their sitemap sometimes concatenates tokens like ".../dailyhttps://"
  // Use a strict domain+path regex and de-dup
  const set = new Set<string>();
  const re = /https?:\/\/cardcookie\.com\/buy-gift-cards\/[a-z0-9\-]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) set.add(m[0]);
  return [...set];
}

function cleanBrandFromH1(raw: string): string {
  // Example H1: "Walmart Discount Gift Cards on Sale!"
  // Keep only the brand portion before "Discount ..."
  let s = decodeHtml(raw).trim();
  s = s.replace(/\s*Discount\s+Gift\s+Cards.*$/i, "").trim();
  // Title-case-ish for acronyms already handled elsewhere;
  // rely on brand normalization/dedup phase to collapse variants.
  return s;
}

function extractDiscountFromTable(html: string): number | null {
  // Looks like: <td class="card-cell card-discount">5%</td>
  const m = html.match(
    /<td[^>]*class=["'][^"']*\bcard-cell\b[^"']*\bcard-discount\b[^"']*["'][^>]*>\s*([0-9]{1,2}(?:\.[0-9])?)\s*%/i
  );
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isNaN(n) ? null : n;
}

function looksOutOfStock(html: string): boolean {
  // Either explicit “out of stock” block or H1 variant like:
  // <div class="out-of-stock"><h1>Men's Wearhouse gift cards are out of stock</h1> ...</div>
  if (/\bout[-\s]?of[-\s]?stock\b/i.test(html)) return true;
  // Some pages might render “Sorry! No available gift cards for this brand now.”
  if (/No available gift cards for this brand/i.test(html)) return true;
  return false;
}

// --- DB helpers (brand-resolution-first to avoid duplicates) ---

async function upsertProvider(sql: any) {
  const rows = await sql/* sql */ `
    INSERT INTO providers (name, slug)
    VALUES ('CardCookie', 'cardcookie')
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return rows[0].id as string;
}

async function resolveOrCreateBrand(sql: any, brandName: string) {
  // Normalization mirrors the functional unique index we discussed earlier
  const normalized = brandName
    .toLowerCase()
    .replace(/\.com\b/i, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const found = await sql/* sql */ `
    WITH norm AS (
      SELECT b.id,
             lower(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(b.name, '\.com\b', '', 'i'),
                 '[^a-zA-Z0-9]+', ' ', 'g'),
               '\s+', ' ', 'g')
             ) AS key
      FROM brands b
    )
    SELECT b.id
    FROM brands b
    JOIN norm n ON n.id = b.id
    WHERE n.key = ${normalized}
       OR EXISTS (
         SELECT 1 FROM brand_aliases a
         WHERE a.brand_id = b.id AND lower(a.alias) = ${brandName.toLowerCase()}
       )
    LIMIT 1
  `;

  if (found.length) {
    const brandId = found[0].id as string;
    // Record the seen spelling as an alias (no-op if exists)
    await sql/* sql */ `
      INSERT INTO brand_aliases (brand_id, alias)
      VALUES (${brandId}, ${brandName})
      ON CONFLICT DO NOTHING
    `;
    return brandId;
  }

  const slug = toSlug(brandName);
  const inserted = await sql/* sql */ `
    INSERT INTO brands (name, slug)
    VALUES (${brandName}, ${slug})
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const brandId = inserted[0].id as string;

  await sql/* sql */ `
    INSERT INTO brand_aliases (brand_id, alias)
    VALUES (${brandId}, ${brandName})
    ON CONFLICT DO NOTHING
  `;

  return brandId;
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

export async function harvestCardCookie(env: Env) {
  const sql = neon(env.DATABASE_URL);
  const providerId = await upsertProvider(sql);

  const sm = await fetchText("https://cardcookie.com/sitemap.xml");
  const urls = extractCardCookieUrls(sm);

  const concurrency = 6;
  const queue = [...new Set(urls)];

  let processed = 0;
  let skippedOutOfStock = 0;

  const workers = Array.from({ length: concurrency }, () =>
    (async () => {
      while (queue.length) {
        const url = queue.pop()!;
        try {
          const html = await fetchText(url);

          // Skip obvious out-of-stock pages
          if (looksOutOfStock(html)) {
            skippedOutOfStock++;
            continue;
          }

          // Brand name
          // Prefer the specific title class if present; otherwise generic <h1>
          const h1 = getH1(html);
          const brandName = cleanBrandFromH1(h1);
          if (!brandName) continue;

          // Discount (if present)
          const pct = extractDiscountFromTable(html);

          // Brand resolution-first to avoid dupes
          const brandId = await resolveOrCreateBrand(sql, brandName);

          // Provider URLs
          await upsertProviderBrandUrl(sql, providerId, brandId, url);

          // Discount
          if (pct != null && pct > 0) {
            await upsertBrandDiscount(sql, providerId, brandId, url, pct);
          }

          processed++;
        } catch {
          // swallow and continue (network blips, etc.)
        }
      }
    })()
  );

  await Promise.all(workers);

  return {
    provider: "cardcookie",
    discovered_urls: urls.length,
    processed,
    skippedOutOfStock,
  };
}
