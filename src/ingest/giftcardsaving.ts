import { neon } from "@neondatabase/serverless";
import { ensureBrandAliasIndexes } from "../db";
import { upsertBrand } from "./brand";

type Env = { DATABASE_URL: string; SCRAPINGBEE_API_KEY?: string };

type BrandItem = {
  id?: string;
  title?: string; // brand display name
  link?: string; // absolute or relative URL to product page
  image?: string;
};

async function upsertProvider(sql: any) {
  const rows = await sql/* sql */ `
    INSERT INTO providers (name, slug)
    VALUES ('GiftCardSaving', 'giftcardsaving')
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return rows[0].id as string;
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

function normalizeUrl(u: string): string {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("/")) return `https://www.giftcardsaving.com${u}`;
  return `https://www.giftcardsaving.com/${u}`;
}

async function fetchTextViaScrapingBee(
  env: Env,
  targetUrl: string,
  opts?: { renderJs?: boolean }
): Promise<string> {
  const apiKey = env.SCRAPINGBEE_API_KEY;
  if (!apiKey) throw new Error("SCRAPINGBEE_API_KEY missing");
  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render_js: opts?.renderJs ? "true" : "false",
    block_resources: opts?.renderJs ? "false" : "true",
  });
  const beeUrl = `https://app.scrapingbee.com/api/v1?${params.toString()}`;
  const r = await fetch(beeUrl, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`ScrapingBee ${r.status} for ${targetUrl}`);
  return r.text();
}

async function fetchJsonViaScrapingBee<T = any>(
  env: Env,
  targetUrl: string
): Promise<T> {
  const text = await fetchTextViaScrapingBee(env, targetUrl, {
    renderJs: false,
  });
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Some setups wrap JSON in <pre> ... </pre>
    const m = cleaned.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (m) {
      const inner = m[1].trim();
      return JSON.parse(inner) as T;
    }
    throw new Error("Failed to parse JSON via ScrapingBee");
  }
}

async function fetchBrandList(env: Env): Promise<BrandItem[]> {
  const url = "https://www.giftcardsaving.com/gift-card/ajax/brands.html";

  // Prefer ScrapingBee to bypass Cloudflare
  if (env.SCRAPINGBEE_API_KEY) {
    try {
      const data = await fetchJsonViaScrapingBee<BrandItem[]>(env, url);
      if (Array.isArray(data) && data.length) return data;
    } catch {
      // continue to direct attempt
    }
    // If JSON parse failed, try reading raw text via ScrapingBee and extracting <pre>
    try {
      const raw = await fetchTextViaScrapingBee(env, url, { renderJs: false });
      const m = raw
        .replace(/^\uFEFF/, "")
        .trim()
        .match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
      if (m) {
        const inner = m[1].trim();
        const json = JSON.parse(inner) as unknown;
        if (Array.isArray(json) && json.length) return json as BrandItem[];
      }
    } catch {
      // ignore
    }
  }

  // Direct GET (may be blocked)
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "application/json, text/plain, */*",
        referer: "https://www.giftcardsaving.com/gift-card.html",
        origin: "https://www.giftcardsaving.com",
        "x-requested-with": "XMLHttpRequest",
      },
    });
    if (!r.ok) throw new Error(`Fetch ${r.status} ${url}`);
    const text = (await r.text()).replace(/^\uFEFF/, "").trim();
    try {
      const json = JSON.parse(text) as unknown;
      if (Array.isArray(json)) return json as BrandItem[];
    } catch {
      const m = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
      if (m) {
        const inner = m[1].trim();
        const json = JSON.parse(inner) as unknown;
        if (Array.isArray(json)) return json as BrandItem[];
      }
    }
  } catch {
    // ignore
  }

  return [];
}

function parseBrandsFromHtml(html: string): BrandItem[] {
  const out: BrandItem[] = [];
  // Look for anchors pointing to brand pages ending in .html (excluding the listing page itself)
  const re =
    /<a[^>]+href=["']([^"']+\.html)["'][^>]*?(?:title=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = (m[1] || "").trim();
    if (!href || /gift-card\.html$/i.test(href)) continue;
    const titleAttr = (m[2] || "").trim();
    const innerText = (m[3] || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const title = (titleAttr || innerText).trim();
    if (!title) continue;
    out.push({ title, link: href });
  }
  // Deduplicate by normalized link
  const seen = new Set<string>();
  const deduped: BrandItem[] = [];
  for (const it of out) {
    const link = normalizeUrl(it.link || "");
    if (!link || seen.has(link)) continue;
    seen.add(link);
    deduped.push({ title: it.title, link });
  }
  return deduped;
}

export async function harvestGiftCardSaving(env: Env) {
  const sql = neon(env.DATABASE_URL);
  await ensureBrandAliasIndexes(sql);
  const providerId = await upsertProvider(sql);

  let list = await fetchBrandList(env);
  let fallbackUsed = false;
  let fallbackSample = "";
  // Fallback: scrape the listing page HTML via ScrapingBee if JSON is blocked
  if ((!list || list.length === 0) && env.SCRAPINGBEE_API_KEY) {
    try {
      const html = await fetchTextViaScrapingBee(
        env,
        "https://www.giftcardsaving.com/gift-card.html",
        { renderJs: true }
      );
      fallbackUsed = true;
      fallbackSample = html.slice(0, 500);
      list = parseBrandsFromHtml(html);
    } catch (e: any) {
      fallbackUsed = true;
      fallbackSample = `Error: ${e.message}`;
    }
  }
  let processed = 0;
  const debug = {
    hasScrapingBeeKey: !!env.SCRAPINGBEE_API_KEY,
    rawListLength: list.length,
    sample: list.slice(0, 3),
    fallbackUsed,
    fallbackSample,
  };

  for (const it of list) {
    const title = (it.title ?? "").trim();
    const link = normalizeUrl((it.link ?? "").trim());
    if (!title || !link) continue;

    const brandId = await upsertBrand(sql, title);
    await upsertProviderBrandUrl(sql, providerId, brandId, link);
    processed++;
  }

  return {
    provider: "giftcardsaving",
    processed,
    discovered: list.length,
    debug,
  };
}
