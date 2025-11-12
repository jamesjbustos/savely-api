import { neon } from "@neondatabase/serverless";
import { upsertBrand } from "./brand";
import { ensureBrandAliasIndexes } from "../db";

type Env = { DATABASE_URL: string; SCRAPINGBEE_API_KEY?: string };

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const r = await fetch(url, {
    ...init,
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json, text/plain, */*",
      referer: "https://www.giftcardoutlets.com/buy-gift-cards",
      origin: "https://www.giftcardoutlets.com",
      "x-requested-with": "XMLHttpRequest",
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Fetch ${r.status} ${url}`);
  return r.text();
}

async function fetchJsonLoose<T = any>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const text = await fetchText(url, init);
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  return JSON.parse(cleaned) as T;
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
    // When rendering JS, do not block resources (scripts)
    block_resources: opts?.renderJs ? "false" : "true",
  });
  const beeUrl = `https://app.scrapingbee.com/api/v1?${params.toString()}`;
  const r = await fetch(beeUrl, {
    headers: { "user-agent": "Mozilla/5.0" },
  });
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
  return JSON.parse(cleaned) as T;
}
async function initSession(): Promise<string | null> {
  const resp = await fetch("https://www.giftcardoutlets.com/buy-gift-cards", {
    method: "GET",
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: "https://www.giftcardoutlets.com/",
    },
  });
  const setCookie = resp.headers.get("set-cookie") || "";
  const m = setCookie.match(/ASP\.NET_SessionId=([^;]+)/i);
  return m ? `ASP.NET_SessionId=${m[1]}` : null;
}

function buildVisitedCookie(env: Env): string | null {
  const anyEnv = env as any;
  const fromEnv = (anyEnv && anyEnv.GCO_VISITED_COOKIE) as string | undefined;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  // Fallback benign value; site likely only checks presence
  return 'visited=["1"]';
}

async function buildCookieHeader(env: Env): Promise<string> {
  const session = await initSession();
  const visited = buildVisitedCookie(env);
  return [session, visited].filter(Boolean).join("; ");
}

async function fetchMerchantList(env: Env): Promise<{ Table?: any[] }> {
  const url = "https://www.giftcardoutlets.com/GetMerchatListForBuyPage";
  // Establish session
  const cookieHeader = await buildCookieHeader(env);
  const commonHeaders: Record<string, string> = {
    "user-agent": "Mozilla/5.0",
    accept: "*/*",
    origin: "https://www.giftcardoutlets.com",
    referer: "https://www.giftcardoutlets.com/buy-gift-cards",
    "x-requested-with": "XMLHttpRequest",
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  };
  // Try POST form with a small body
  try {
    const j = await fetchJsonLoose<{ Table?: any[] }>(url, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: "page=1",
    });
    if (Array.isArray(j?.Table) && j.Table.length > 0) return j;
  } catch {}
  // Try GET
  try {
    const j = await fetchJsonLoose<{ Table?: any[] }>(url, {
      method: "GET",
      headers: commonHeaders,
    });
    if (Array.isArray(j?.Table) && j.Table.length > 0) return j;
  } catch {}
  // Try POST with JSON
  try {
    const j = await fetchJsonLoose<{ Table?: any[] }>(url, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "content-type": "application/json;charset=UTF-8",
      },
      body: "{}",
    });
    if (Array.isArray(j?.Table) && j.Table.length > 0) return j;
  } catch {}
  // Try POST form-encoded (common for legacy .NET)
  try {
    const j = await fetchJsonLoose<{ Table?: any[] }>(url, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: "",
    });
    if (Array.isArray(j?.Table) && j.Table.length > 0) return j;
  } catch {}
  return { Table: [] };
}

async function upsertProvider(sql: any) {
  const rows = await sql/* sql */ `
    INSERT INTO providers (name, slug)
    VALUES ('GiftCardOutlets', 'giftcardoutlets')
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

type ScrapedRow = { mNm: string; pageURL: string; uptoDisc: number | null };

function parseListingPage(html: string): ScrapedRow[] {
  const out: ScrapedRow[] = [];
  const cardRe =
    /<div[^>]*class=["'][^"']*\bcards\b[^"']*["'][\s\S]*?<a[^>]*href=["']([^"']+)["'][\s\S]*?<\/a>[\s\S]*?<p[^>]*class=["'][^"']*\bbrandName\b[^"']*["'][^>]*>([\s\S]*?)<\/p>[\s\S]*?<p[^>]*class=["'][^"']*\bdiscount\b[^"']*["'][^>]*>[^<]*?(\d{1,2}(?:\.\d{1,2})?)\s*%/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html))) {
    const href = m[1].trim();
    const nameRaw = m[2].replace(/<[^>]*>/g, "").trim();
    const pctStr = m[3].trim();
    const pct = Number.isNaN(parseFloat(pctStr))
      ? null
      : Math.round(parseFloat(pctStr) * 10) / 10;
    const slugMatch = href.match(/\/buy-gift-cards\/([^\/]+)\/?$/i);
    const slugPart = slugMatch ? slugMatch[1] : "";
    const name = nameRaw.replace(/\s*Gift\s*Cards\s*$/i, "").trim();
    if (name && slugPart) {
      out.push({ mNm: name, pageURL: slugPart, uptoDisc: pct });
    }
  }
  return out;
}

/**
 * Uses GiftCardOutlets API:
 *   GET https://www.giftcardoutlets.com/GetMerchatListForBuyPage
 * Returns shape: { Table: [{ mNm, pageURL, uptoDisc, ... }, ...] }
 * Product URL template: https://www.giftcardoutlets.com/buy-gift-cards/{pageURL}
 */
export async function harvestGiftCardOutlets(env: Env) {
  const sql = neon(env.DATABASE_URL);
  await ensureBrandAliasIndexes(sql);
  const providerId = await upsertProvider(sql);

  type ApiRow = {
    mID?: number;
    mNm?: string;
    pageURL?: string;
    TotalCards?: number;
    buyer_disc?: number;
    uptoDisc?: number;
  };
  type ApiResp = { Table?: ApiRow[] };

  let items: ApiRow[] = [];

  // 1) Prefer ScrapingBee listing scrape if API key is present (bypasses CF)
  if (env.SCRAPINGBEE_API_KEY) {
    try {
      const html = await fetchTextViaScrapingBee(
        env,
        "https://www.giftcardoutlets.com/buy-gift-cards",
        { renderJs: true }
      );
      const scraped = parseListingPage(html);
      items = scraped as unknown as ApiRow[];
    } catch {
      // ignore; we'll try API next
    }
  }

  // 2) Try API-based listing (first via ScrapingBee), then with session cookies
  if (items.length === 0) {
    if (env.SCRAPINGBEE_API_KEY) {
      try {
        const dataBee = await fetchJsonViaScrapingBee<ApiResp>(
          env,
          "https://www.giftcardoutlets.com/GetMerchatListForBuyPage"
        );
        items = dataBee?.Table ?? [];
      } catch {
        // continue to direct
      }
    }
    if (items.length === 0) {
      const data = (await fetchMerchantList(env)) as ApiResp;
      items = data?.Table ?? [];
    }
  }

  // 3) Fallback to direct HTML listing fetch if still empty
  if (items.length === 0) {
    try {
      const cookieHeader = await buildCookieHeader(env);
      const listingHtml = await fetchText(
        "https://www.giftcardoutlets.com/buy-gift-cards",
        {
          method: "GET",
          headers: {
            "user-agent": "Mozilla/5.0",
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            referer: "https://www.giftcardoutlets.com/",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
            "upgrade-insecure-requests": "1",
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
        }
      );
      const scraped = parseListingPage(listingHtml);
      items = scraped as unknown as ApiRow[];
    } catch {
      // swallow; will return zeros
    }
  }
  let processed = 0;

  for (const it of items) {
    const name = (it.mNm ?? "").trim();
    const page = (it.pageURL ?? "").trim();
    if (!name || !page) continue;

    const productUrl = `https://www.giftcardoutlets.com/buy-gift-cards/${page}`;
    const pct =
      typeof it.uptoDisc === "number"
        ? Math.round(it.uptoDisc * 10) / 10
        : typeof it.buyer_disc === "number"
        ? Math.round(it.buyer_disc * 10) / 10
        : null;

    const brandId = await upsertBrand(sql, name);
    await upsertProviderBrandUrl(sql, providerId, brandId, productUrl);
    if (pct != null && pct > 0) {
      await upsertBrandDiscount(sql, providerId, brandId, productUrl, pct);
    }
    processed++;
  }

  return { provider: "giftcardoutlets", processed, discovered: items.length };
}
