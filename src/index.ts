import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb } from "./db.ts";

type Env = {
  DATABASE_URL: string;
  EXTENSION_API_KEY: string;
  HYPERDRIVE?: { connectionString: string };
  KV?: KVNamespace;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  CRON_SECRET?: string;
};

interface KVNamespace {
  get(key: string, type?: "text"): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

// Fire-and-forget ingest to Axiom. Batched events get sent as a single POST.
async function ingestToAxiom(
  env: Env,
  events: Record<string, unknown>[],
): Promise<void> {
  const token = env.AXIOM_TOKEN;
  const dataset = env.AXIOM_DATASET;
  if (!token || !dataset || events.length === 0) return;

  try {
    const resp = await fetch(
      `https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(events),
      },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[axiom] ingest failed:", resp.status, errText);
    }
  } catch (err) {
    console.error("[axiom] ingest error:", err);
  }
}


const app = new Hono<{ Bindings: Env }>();

// CORS — allow the web app and local dev origins.
// The browser extension uses background-script fetch (no CORS restrictions).
app.use(
  "*",
  cors({
    origin: [
      "https://carddeals.co",
      "https://www.carddeals.co",
      "http://localhost:3000",
      "http://localhost:3001",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-extension-key", "x-viewer-id"],
    maxAge: 86400,
  })
);

// Security headers
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
});

const OFFERS_CLIENT_TTL_SECONDS = 30;

function getCache() {
  const globalCaches = (globalThis as any).caches;
  if (!globalCaches || !globalCaches.default) return null;
  return globalCaches.default as {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
}

// Cache helper: checks cache, returns cached response if fresh, otherwise null.
// Uses Cache-Control max-age natively instead of manual timestamp tracking.
// Cached responses are rebuilt with mutable headers so downstream middleware
// (e.g. security headers) can modify them without hitting "immutable headers" errors.
async function getCached(url: string): Promise<{ cache: any; cacheKey: Request; cached: Response | null }> {
  const cache = getCache();
  if (!cache) return { cache: null, cacheKey: null as any, cached: null };
  const cacheKey = new Request(url, { method: "GET" });
  const match = await cache.match(cacheKey);
  if (!match) return { cache, cacheKey, cached: null };
  // Reconstruct with mutable headers — Cache API responses have immutable headers
  const cached = new Response(match.body, {
    status: match.status,
    statusText: match.statusText,
    headers: new Headers(match.headers),
  });
  return { cache, cacheKey, cached };
}

// Store response in cache with proper Cache-Control header and optional client SWR.
function cacheResponse(
  response: Response,
  cache: any,
  cacheKey: Request,
  ctx: { waitUntil?(p: Promise<unknown>): void } | undefined,
  maxAgeSec: number,
  swrSec = 0,
) {
  const parts = [`public`, `max-age=${maxAgeSec}`];
  if (swrSec > 0) parts.push(`stale-while-revalidate=${swrSec}`);
  response.headers.set("Cache-Control", parts.join(", "));

  if (cache && cacheKey && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(
      cache.put(cacheKey, response.clone()).catch((err: unknown) => {
        console.error("Cache put error:", err);
      }),
    );
  }

  return response;
}

function variantToLabel(variant: string | null | undefined): string | null {
  if (!variant) return null;
  if (variant === "online") return "Online";
  if (variant === "in_store") return "In-store only";
  return null; // "other" → no label
}

function normalizeSamsClubMatchText(input: string): string {
  let text = input;
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }

  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-s(?=-|$)/g, "s")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

function extractSamsClubProductKey(productUrl: string | null): string {
  if (!productUrl) return "";

  let rawUrl = productUrl;
  try {
    const affiliateUrl = new URL(productUrl);
    rawUrl = affiliateUrl.searchParams.get("murl") || productUrl;
  } catch {
    rawUrl = productUrl;
  }

  try {
    const samsUrl = new URL(rawUrl);
    const productPath = samsUrl.pathname.match(/\/ip\/([^/?#]+)/i)?.[1];
    return normalizeSamsClubMatchText(productPath || samsUrl.pathname);
  } catch {
    return normalizeSamsClubMatchText(rawUrl);
  }
}

function isSamsClubOfferForBrand(
  providerSlug: string,
  productUrl: string | null,
  brandName: string,
  brandSlug: string
): boolean {
  if (providerSlug !== "samsclub") return true;

  const productKey = extractSamsClubProductKey(productUrl);
  if (!productKey) return true;

  const candidates = [
    normalizeSamsClubMatchText(brandName),
    normalizeSamsClubMatchText(brandSlug),
  ].filter((candidate) => candidate.length >= 3);

  return candidates.some((candidate) =>
    `-${productKey}-`.includes(`-${candidate}-`)
  );
}

app.get("/health", (c) => c.text("ok"));

// GET /brands
// Public directory of brands with their best available discount.
// Supports optional search, discount filtering, sorting, and pagination.
app.get("/brands", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);

  const qRaw = c.req.query("q") || "";
  const searchTerm = qRaw.trim();
  const hasSearch = searchTerm.length > 0;
  const searchPattern = hasSearch ? `%${searchTerm}%` : "%";

  // starts_with parameter for alphabetical filtering (e.g., "A" matches "Amazon", "Apple")
  const startsWithRaw = c.req.query("starts_with") || "";
  const startsWithTerm = startsWithRaw.trim();
  const hasStartsWith = startsWithTerm.length > 0;
  const startsWithPattern = hasStartsWith ? `${startsWithTerm}%` : "%";

  const categoryParam = c.req.query("category") || "";
  const categorySlug = categoryParam.trim();
  const hasCategory = categorySlug.length > 0;

  const minDiscountParam = c.req.query("min_discount");
  const maxDiscountParam = c.req.query("max_discount");
  const minDiscountRaw = minDiscountParam
    ? Number.parseFloat(minDiscountParam)
    : NaN;
  const maxDiscountRaw = maxDiscountParam
    ? Number.parseFloat(maxDiscountParam)
    : NaN;
  const useMinDiscount = Number.isFinite(minDiscountRaw);
  const useMaxDiscount = Number.isFinite(maxDiscountRaw);
  const minDiscount = useMinDiscount ? minDiscountRaw : 0;
  const maxDiscount = useMaxDiscount ? maxDiscountRaw : 0;

  const sortParam = (c.req.query("sort") || "az").toLowerCase();
  const pageParam = c.req.query("page") || "1";
  const pageSizeParam = c.req.query("page_size") || "24";

  const pageRaw = Number.parseInt(pageParam, 10);
  const pageSizeRaw = Number.parseInt(pageSizeParam, 10);

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  // Cap raised to 1000 so the sitemap can fetch in 1-2 calls instead of 14+.
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), 1000)
    : 24;
  const offset = (page - 1) * pageSize;

  const orderBy =
    sortParam === "newest"
      ? sql`order by coalesce(last_deal_updated, brand_created_at) desc nulls last, brand_name asc`
      : sortParam === "discount_desc" || sortParam === "relevance"
      ? sql`order by best_discount desc nulls last, brand_name asc`
      : sortParam === "discount_asc"
      ? sql`order by best_discount asc nulls last, brand_name asc`
      : sql`order by brand_name asc`;

  const rows = await sql/* sql */ `
    with latest_deal_change as (
      select
        brand_id,
        max(observed_at) as last_deal_updated
      from provider_brand_discount_history
      group by brand_id
    ),
    filtered as (
      select
        v.brand_id,
        v.brand_name,
        v.brand_slug,
        v.base_domain,
        b.description as brand_description,
        b.created_at as brand_created_at,
        ldc.last_deal_updated,
        max(v.max_discount_percent) as best_discount,
        bool_or(v.in_stock) as in_stock,
        c.id as category_id,
        c.name as category_name,
        c.slug as category_slug
      from v_brand_provider_offers v
      join brands b on b.id = v.brand_id
      left join latest_deal_change ldc on ldc.brand_id = v.brand_id
      left join categories c on c.id = b.category_id
      where b.status = 'active'
        and v.max_discount_percent is not null
        and v.in_stock = true
        and v.product_url is not null
        and (
          ${hasSearch} = false
          or lower(b.name) like lower(${searchPattern})
          or lower(b.slug) like lower(${searchPattern})
        )
        and (
          ${hasStartsWith} = false
          or lower(b.name) like lower(${startsWithPattern})
        )
        and (
          ${hasCategory} = false
          or c.slug = ${categorySlug}
        )
      group by
        v.brand_id,
        v.brand_name,
        v.brand_slug,
        v.base_domain,
        b.description,
        b.created_at,
        ldc.last_deal_updated,
        c.id,
        c.name,
        c.slug
      having
        (${useMinDiscount} = false or max(v.max_discount_percent) >= ${minDiscount})
        and (${useMaxDiscount} = false or max(v.max_discount_percent) <= ${maxDiscount})
    )
    select *, count(*) over () as total_count
    from filtered
    ${orderBy}
    limit ${pageSize} offset ${offset}
  `;

  type Row = {
    brand_id: string;
    brand_name: string;
    brand_slug: string;
    base_domain: string | null;
    brand_description: string | null;
    brand_created_at: string | null;
    last_deal_updated: string | null;
    best_discount: number | string | null;
    in_stock: boolean;
    category_id: string | null;
    category_name: string | null;
    category_slug: string | null;
    total_count: number | string;
  };

  const total =
    rows.length > 0
      ? Number((rows[0] as any).total_count) || 0
      : 0;

  const brands = (rows as any as Row[]).map((r) => {
    const bestDiscount =
      r.best_discount == null
        ? null
        : typeof r.best_discount === "number"
        ? r.best_discount
        : Number(r.best_discount);

    const category = r.category_id
      ? {
          id: r.category_id,
          name: r.category_name as string,
          slug: r.category_slug as string,
        }
      : null;

    return {
      id: r.brand_id,
      name: r.brand_name,
      slug: r.brand_slug,
      base_domain: r.base_domain ?? null,
      description: r.brand_description ?? null,
      created_at: r.brand_created_at ?? null,
      last_deal_updated: r.last_deal_updated ?? null,
      max_discount_percent: bestDiscount,
      in_stock: !!r.in_stock,
      category,
    };
  });

  const response = c.json({
    page,
    page_size: pageSize,
    total,
    brands,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 1800, 7200);
});

// GET /brands/:slug
// Public detail view for a single brand and its provider offers.
app.get("/brands/:slug", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);
  const slug = c.req.param("slug");

  const brandRows = await sql/* sql */ `
    select
      b.id,
      b.name,
      b.slug,
      b.base_domain,
      b.description,
      b.status,
      c.id as category_id,
      c.name as category_name,
      c.slug as category_slug
    from brands b
    left join categories c on c.id = b.category_id
    where b.slug = ${slug}
    limit 1
  `;

  if (!brandRows.length || brandRows[0]?.status !== "active") {
    return c.json({ error: "Brand not found" }, 404);
  }

  const brandRow = brandRows[0] as any;

  const offerRows = await sql/* sql */ `
    select
      v.provider_id,
      v.provider_name,
      v.provider_slug,
      v.max_discount_percent,
      v.in_stock,
      v.product_url,
      v.variant
    from v_brand_provider_offers v
    where v.brand_id = ${brandRow.id}
      and v.max_discount_percent is not null
    order by
      v.in_stock desc,
      v.max_discount_percent desc nulls last,
      v.provider_name asc
  `;

  type OfferRow = {
    provider_id: string;
    provider_name: string;
    provider_slug: string;
    max_discount_percent: number | string | null;
    in_stock: boolean;
    product_url: string | null;
    variant: string | null;
  };

  type Offer = {
    provider_id: string;
    provider_name: string;
    provider_slug: string;
    discount_percent: number | null;
    in_stock: boolean;
    product_url: string | null;
    variant: string | null;
    variant_label: string | null;
  };

  function isBetterOffer(next: Offer, current: Offer): boolean {
    if (next.in_stock !== current.in_stock) return next.in_stock;
    return (next.discount_percent ?? 0) > (current.discount_percent ?? 0);
  }

  const offersAll = (offerRows as any as OfferRow[]).map((r): Offer => {
    const rawDiscount = r.max_discount_percent;
    const discount =
      rawDiscount == null
        ? null
        : typeof rawDiscount === "number"
        ? rawDiscount
        : Number(rawDiscount);
    const variant = r.variant;

    return {
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      provider_slug: r.provider_slug,
      discount_percent: discount,
      in_stock: !!r.in_stock,
      product_url: r.product_url,
      variant,
      variant_label: variantToLabel(variant),
    };
  });

  const brandName = brandRow.name as string;
  const brandSlug = brandRow.slug as string;
  const samsClubSafeOffers = offersAll.filter((offer) =>
    isSamsClubOfferForBrand(
      offer.provider_slug,
      offer.product_url,
      brandName,
      brandSlug
    )
  );

  const bestSamsClubOfferByProvider = new Map<string, Offer>();
  const offersWithSamsClubDeduped: Offer[] = [];
  for (const offer of samsClubSafeOffers) {
    if (offer.provider_slug !== "samsclub") {
      offersWithSamsClubDeduped.push(offer);
      continue;
    }

    const current = bestSamsClubOfferByProvider.get(offer.provider_id);
    if (!current || isBetterOffer(offer, current)) {
      bestSamsClubOfferByProvider.set(offer.provider_id, offer);
    }
  }
  offersWithSamsClubDeduped.push(...bestSamsClubOfferByProvider.values());

  const clickableOffers = offersWithSamsClubDeduped.filter(
    (o) =>
      o.in_stock &&
      o.discount_percent != null &&
      o.discount_percent > 0 &&
      typeof o.product_url === "string" &&
      o.product_url
  );

  const maxDiscount =
    clickableOffers.length > 0
      ? clickableOffers.reduce(
          (max, o) =>
            o.discount_percent != null && o.discount_percent > max
              ? o.discount_percent
              : max,
          0
        )
      : null;

  const category = brandRow.category_id
    ? {
        id: brandRow.category_id as string,
        name: brandRow.category_name as string,
        slug: brandRow.category_slug as string,
      }
    : null;

  const brand = {
    id: brandRow.id as string,
    name: brandRow.name as string,
    slug: brandRow.slug as string,
    base_domain: (brandRow.base_domain as string | null) ?? null,
    description: (brandRow.description as string | null) ?? null,
    max_discount_percent: maxDiscount,
    category,
  };

  const response = c.json({
    brand,
    offers: clickableOffers,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 600, 3600);
});

// GET /categories
// Returns all categories with computed brand counts and max discounts.
app.get("/categories", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);

  const rows = await sql/* sql */ `
    select
      c.id,
      c.name,
      c.slug,
      c.description,
      c.icon_name,
      c.tone,
      c.display_order,
      coalesce(stats.brand_count, 0) as brand_count,
      coalesce(stats.max_discount, 0) as max_discount
    from categories c
    left join (
      select
        b.category_id,
        count(distinct b.id) as brand_count,
        max(pbd.max_discount_percent) as max_discount
      from brands b
      left join provider_brand_discounts pbd on pbd.brand_id = b.id and pbd.in_stock = true
      where b.status = 'active'
        and b.category_id is not null
      group by b.category_id
    ) stats on stats.category_id = c.id
    order by c.display_order asc
  `;

  type Row = {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    icon_name: string;
    tone: string | null;
    display_order: number;
    brand_count: number | string;
    max_discount: number | string | null;
  };

  const categories = (rows as any as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    icon_name: r.icon_name,
    tone: r.tone,
    brand_count:
      typeof r.brand_count === "number"
        ? r.brand_count
        : Number(r.brand_count) || 0,
    max_discount:
      r.max_discount == null
        ? 0
        : typeof r.max_discount === "number"
        ? r.max_discount
        : Number(r.max_discount) || 0,
  }));

  const response = c.json({ categories });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 3600, 600);
});

// GET /categories/:slug
// Returns single category with paginated brands.
app.get("/categories/:slug", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);
  const slug = c.req.param("slug");

  const categoryRows = await sql/* sql */ `
    select
      id,
      name,
      slug,
      description,
      icon_name,
      tone
    from categories
    where slug = ${slug}
    limit 1
  `;

  if (!categoryRows.length) {
    return c.json({ error: "Category not found" }, 404);
  }

  const categoryRow = categoryRows[0] as any;

  const pageParam = c.req.query("page") || "1";
  const pageSizeParam = c.req.query("page_size") || "24";
  const sortParam = c.req.query("sort") || "best_match";

  const pageRaw = Number.parseInt(pageParam, 10);
  const pageSizeRaw = Number.parseInt(pageSizeParam, 10);

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), 100)
    : 24;
  const offset = (page - 1) * pageSize;

  // Run stats and brand queries in parallel
  // Use the v_brand_provider_offers view so that product-level overrides
  // (provider_brand_products.is_active / discount_percent) are respected,
  // matching the logic on brand detail pages.
  const statsQuery = sql/* sql */ `
    select
      count(distinct b.id) as total,
      max(v.max_discount_percent) as max_discount
    from brands b
    left join v_brand_provider_offers v on v.brand_id = b.id and v.in_stock = true
    where b.category_id = ${categoryRow.id}
      and b.status = 'active'
  `;

  // Use separate queries per sort to avoid dynamic ORDER BY (Neon driver limitation)
  const brandQuery =
    sortParam === "az"
      ? sql/* sql */ `
          select
            b.id, b.name, b.slug, b.base_domain,
            max(v.max_discount_percent) as max_discount_percent,
            coalesce(bool_or(v.in_stock), false) as in_stock
          from brands b
          left join v_brand_provider_offers v on v.brand_id = b.id and v.in_stock = true
          where b.category_id = ${categoryRow.id} and b.status = 'active'
          group by b.id, b.name, b.slug, b.base_domain
          order by b.name asc
          limit ${pageSize} offset ${offset}
        `
      : sql/* sql */ `
          select
            b.id, b.name, b.slug, b.base_domain,
            max(v.max_discount_percent) as max_discount_percent,
            coalesce(bool_or(v.in_stock), false) as in_stock
          from brands b
          left join v_brand_provider_offers v on v.brand_id = b.id and v.in_stock = true
          where b.category_id = ${categoryRow.id} and b.status = 'active'
          group by b.id, b.name, b.slug, b.base_domain
          order by max(v.max_discount_percent) desc nulls last, b.name asc
          limit ${pageSize} offset ${offset}
        `;

  const [statsRow, brandRows] = await Promise.all([statsQuery, brandQuery]);

  const total =
    typeof (statsRow[0] as any)?.total === "number"
      ? (statsRow[0] as any).total
      : Number((statsRow[0] as any)?.total) || 0;

  const categoryMaxDiscount =
    (statsRow[0] as any)?.max_discount == null
      ? 0
      : typeof (statsRow[0] as any).max_discount === "number"
      ? (statsRow[0] as any).max_discount
      : Number((statsRow[0] as any).max_discount) || 0;

  type BrandRow = {
    id: string;
    name: string;
    slug: string;
    base_domain: string | null;
    max_discount_percent: number | string | null;
    in_stock: boolean;
  };

  const brands = (brandRows as any as BrandRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    base_domain: r.base_domain,
    max_discount_percent:
      r.max_discount_percent == null
        ? null
        : typeof r.max_discount_percent === "number"
        ? r.max_discount_percent
        : Number(r.max_discount_percent),
    in_stock: !!r.in_stock,
  }));

  const category = {
    id: categoryRow.id as string,
    name: categoryRow.name as string,
    slug: categoryRow.slug as string,
    description: (categoryRow.description as string | null) ?? null,
    icon_name: categoryRow.icon_name as string,
    tone: (categoryRow.tone as string | null) ?? null,
    max_discount: categoryMaxDiscount,
    brand_count: total,
  };

  const response = c.json({
    category,
    page,
    page_size: pageSize,
    total,
    brands,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 1800, 7200);
});

// GET /popular-brands?limit=20
// Returns popular brands from pre-computed KV data (populated by scheduled cron).
// Falls back to top-discount brands if KV data isn't available yet.
app.get("/popular-brands", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const limitParam = c.req.query("limit") || "20";
  const limitRaw = Number.parseInt(limitParam, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 20;

  // Try KV first (pre-computed by scheduled cron from Analytics Engine)
  const kv = c.env.KV;
  if (kv) {
    const kvData = await kv.get("popular-brands", "json") as any;
    if (kvData && Array.isArray(kvData.brands)) {
      const brands = kvData.brands.slice(0, limit);
      const response = c.json({
        window_hours: kvData.window_hours ?? 24,
        limit,
        brands,
        source: "analytics_engine",
        computed_at: kvData.computed_at ?? null,
      });
      return cacheResponse(response, cache, cacheKey, c.executionCtx, 600, 3600);
    }
  }

  // Fallback: return top-discount brands (no brand_daily_viewers query)
  const sql = getDb(c.env);
  const rows = await sql/* sql */ `
    select distinct on (b.id)
      b.id as brand_id,
      b.name,
      b.slug,
      b.base_domain,
      pbd.max_discount_percent,
      c.name as category_name
    from provider_brand_discounts pbd
    join brands b on b.id = pbd.brand_id
    left join categories c on c.id = b.category_id
    where pbd.in_stock = true
      and b.status = 'active'
      and pbd.max_discount_percent > 0
    order by b.id, pbd.max_discount_percent desc
    limit ${limit}
  `;

  const brands = (rows as any[]).map((r) => ({
    id: r.brand_id as string,
    name: r.name as string,
    slug: r.slug as string,
    base_domain: (r.base_domain as string | null) ?? null,
    category_name: (r.category_name as string | null) ?? null,
    event_count: 0,
    max_discount_percent:
      typeof r.max_discount_percent === "number"
        ? r.max_discount_percent
        : Number(r.max_discount_percent) || 0,
  }));

  const response = c.json({
    window_hours: 24,
    limit,
    brands,
    source: "fallback",
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 600, 3600);
});

// GET /analytics/biggest-price-drops?window_hours=24&limit=20
// Biggest positive changes in max discount over the window, aggregated per brand.
app.get("/analytics/biggest-price-drops", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);

  const windowParam = c.req.query("window_hours") || "24";
  const limitParam = c.req.query("limit") || "20";

  const windowHoursRaw = Number.parseInt(windowParam, 10);
  const limitRaw = Number.parseInt(limitParam, 10);

  const windowHours = Number.isFinite(windowHoursRaw)
    ? Math.min(Math.max(windowHoursRaw, 1), 24 * 30)
    : 24;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 20;

  const rows = await sql/* sql */ `
    with time_window as (
      select now() - (${windowHours} * interval '1 hour') as window_start
    ),
    baseline as (
      select distinct on (h.provider_id, h.brand_id)
        h.provider_id,
        h.brand_id,
        h.max_discount_percent as prev_discount
      from provider_brand_discount_history h, time_window tw
      where h.observed_at <= tw.window_start
      order by h.provider_id, h.brand_id, h.observed_at desc
    ),
    current as (
      select
        pbd.provider_id,
        pbd.brand_id,
        pbd.max_discount_percent as current_discount
      from provider_brand_discounts pbd
      where pbd.in_stock = true
    )
    select
      b.id as brand_id,
      b.name as brand_name,
      b.slug as brand_slug,
      b.base_domain,
      p.id as provider_id,
      p.name as provider_name,
      p.slug as provider_slug,
      current.current_discount,
      baseline.prev_discount as prev_discount
    from current
    join brands b on b.id = current.brand_id
    join providers p on p.id = current.provider_id
    left join baseline
      on baseline.provider_id = current.provider_id
     and baseline.brand_id = current.brand_id
    where b.status = 'active'
  `;

  type Row = {
    brand_id: string;
    brand_name: string;
    brand_slug: string;
    base_domain: string | null;
    provider_id: string;
    provider_name: string;
    provider_slug: string;
    current_discount: number | string | null;
    prev_discount: number | string | null;
  };

  const byBrand = new Map<
    string,
    {
      brand_id: string;
      brand_name: string;
      brand_slug: string;
      base_domain: string | null;
      provider_id: string;
      provider_name: string;
      provider_slug: string;
      current_discount_percent: number;
      previous_discount_percent: number;
      delta_discount_percent: number;
    }
  >();

  for (const r of rows as any as Row[]) {
    if (r.prev_discount == null) {
      // No known discount state at the start of the window; skip this brand
      // to avoid treating "newly tracked" brands as large drops from 0%.
      continue;
    }

    const current =
      r.current_discount == null
        ? 0
        : typeof r.current_discount === "number"
        ? r.current_discount
        : Number(r.current_discount);
    const prev =
      r.prev_discount == null
        ? 0
        : typeof r.prev_discount === "number"
        ? r.prev_discount
        : Number(r.prev_discount);

    if (!Number.isFinite(current) || !Number.isFinite(prev)) continue;

    // Treat "price drops" strictly as increases from a prior non-zero
    // discount; skip cases where the previous discount was 0 or less,
    // since those are better interpreted as newly discounted brands.
    if (prev <= 0) continue;

    const delta = current - prev;
    if (current <= 0 || delta <= 0) continue;

    const existing = byBrand.get(r.brand_id);
    if (!existing || delta > existing.delta_discount_percent) {
      byBrand.set(r.brand_id, {
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        brand_slug: r.brand_slug,
        base_domain: r.base_domain,
        provider_id: r.provider_id,
        provider_name: r.provider_name,
        provider_slug: r.provider_slug,
        current_discount_percent: current,
        previous_discount_percent: prev,
        delta_discount_percent: delta,
      });
    }
  }

  let brands = Array.from(byBrand.values());
  brands.sort((a, b) => b.delta_discount_percent - a.delta_discount_percent);
  if (brands.length > limit) {
    brands = brands.slice(0, limit);
  }

  const response = c.json({
    window_hours: windowHours,
    limit,
    brands,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 600, 3600);
});

// GET /analytics/popular-giftcards?limit=20
// Popular brands from pre-computed KV data, filtered to brands with live offers.
app.get("/analytics/popular-giftcards", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const limitParam = c.req.query("limit") || "20";
  const limitRaw = Number.parseInt(limitParam, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 20;

  // Read from KV (same data as /popular-brands, already filtered to in-stock brands)
  const kv = c.env.KV;
  if (kv) {
    const kvData = await kv.get("popular-brands", "json") as any;
    if (kvData && Array.isArray(kvData.brands)) {
      const brands = kvData.brands.slice(0, limit).map((b: any) => ({
        brand_id: b.id,
        brand_name: b.name,
        brand_slug: b.slug,
        base_domain: b.base_domain,
        view_count: b.event_count ?? 0,
        best_discount_percent: b.max_discount_percent,
      }));

      const response = c.json({
        window_hours: kvData.window_hours ?? 24,
        limit,
        brands,
      });
      return cacheResponse(response, cache, cacheKey, c.executionCtx, 600, 3600);
    }
  }

  // Fallback: top discounts (no brand_daily_viewers query)
  const sql = getDb(c.env);
  const rows = await sql/* sql */ `
    select distinct on (b.id)
      b.id as brand_id,
      b.name as brand_name,
      b.slug as brand_slug,
      b.base_domain,
      v.max_discount_percent as best_discount
    from v_brand_provider_offers v
    join brands b on b.id = v.brand_id
    where v.in_stock = true and b.status = 'active'
    order by b.id, v.max_discount_percent desc
    limit ${limit}
  `;

  const brands = (rows as any[]).map((r) => ({
    brand_id: r.brand_id,
    brand_name: r.brand_name,
    brand_slug: r.brand_slug,
    base_domain: (r.base_domain as string | null) ?? null,
    view_count: 0,
    best_discount_percent:
      r.best_discount == null ? null
        : typeof r.best_discount === "number" ? r.best_discount
        : Number(r.best_discount),
  }));

  const response = c.json({
    window_hours: 24,
    limit,
    brands,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 600, 3600);
});

// GET /analytics/top-discounts?limit=20
// Highest current discounts per brand (best offer per brand).
app.get("/analytics/top-discounts", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);

  const limitParam = c.req.query("limit") || "20";
  const limitRaw = Number.parseInt(limitParam, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 20;

  const rows = await sql/* sql */ `
    select distinct on (v.brand_id)
      v.brand_id,
      v.brand_name,
      v.brand_slug,
      v.base_domain,
      v.provider_id,
      v.provider_name,
      v.provider_slug,
      v.max_discount_percent,
      v.product_url,
      v.variant
    from v_brand_provider_offers v
    join brands b on b.id = v.brand_id
    where v.in_stock = true
      and b.status = 'active'
      and v.max_discount_percent is not null
    order by
      v.brand_id,
      v.max_discount_percent desc nulls last,
      v.provider_name asc
    limit ${limit}
  `;

  const brands = (rows as any[]).map((r) => {
    const variant = (r.variant as string | null) ?? null;
    const discount =
      typeof r.max_discount_percent === "number"
        ? r.max_discount_percent
        : Number(r.max_discount_percent);

    return {
      brand_id: r.brand_id as string,
      brand_name: r.brand_name as string,
      brand_slug: r.brand_slug as string,
      base_domain: (r.base_domain as string | null) ?? null,
      provider_id: r.provider_id as string,
      provider_name: r.provider_name as string,
      provider_slug: r.provider_slug as string,
      discount_percent: discount,
      product_url: (r.product_url as string | null) ?? null,
      variant,
      variant_label: variantToLabel(variant),
    };
  });

  const response = c.json({
    limit,
    brands,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 600, 3600);
});

// GET /analytics/live-offers?window_hours=168
// Returns time series of live offers based on offer_inventory_snapshots:
//  - totals: summed live offers across all providers per snapshot_at
//  - by_provider: per-provider series with provider metadata
app.get("/analytics/live-offers", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);

  const windowParam = c.req.query("window_hours") || "168";
  const windowHoursRaw = Number.parseInt(windowParam, 10);
  const windowHours = Number.isFinite(windowHoursRaw)
    ? Math.min(Math.max(windowHoursRaw, 1), 24 * 30)
    : 168;

  const rows = await sql/* sql */ `
    select
      s.snapshot_at,
      s.provider_id,
      p.name as provider_name,
      p.slug as provider_slug,
      s.live_offer_count
    from offer_inventory_snapshots s
    join providers p on p.id = s.provider_id
    where s.snapshot_at >= now() - (${windowHours} * interval '1 hour')
    order by s.snapshot_at asc, p.name asc
  `;

  type Row = {
    snapshot_at: string | Date;
    provider_id: string;
    provider_name: string;
    provider_slug: string;
    live_offer_count: number | string;
  };

  const totalsMap = new Map<string, number>();
  const perProvider = new Map<
    string,
    {
      provider_id: string;
      provider_name: string;
      provider_slug: string;
      snapshots: { snapshot_at: string; live_offer_count: number }[];
    }
  >();

  for (const r of rows as any as Row[]) {
    const snapshotAtRaw = r.snapshot_at;
    const snapshotAt =
      snapshotAtRaw instanceof Date
        ? snapshotAtRaw.toISOString()
        : String(snapshotAtRaw);
    const liveCount =
      typeof r.live_offer_count === "number"
        ? r.live_offer_count
        : Number(r.live_offer_count);
    const prevTotal = totalsMap.get(snapshotAt) ?? 0;
    totalsMap.set(snapshotAt, prevTotal + liveCount);

    let entry = perProvider.get(r.provider_id);
    if (!entry) {
      entry = {
        provider_id: r.provider_id,
        provider_name: r.provider_name,
        provider_slug: r.provider_slug,
        snapshots: [],
      };
      perProvider.set(r.provider_id, entry);
    }
    entry.snapshots.push({
      snapshot_at: snapshotAt,
      live_offer_count: liveCount,
    });
  }

  const totals = Array.from(totalsMap.entries())
    .map(([snapshot_at, live_offer_count]) => ({
      snapshot_at,
      live_offer_count,
    }))
    .sort((a, b) =>
      a.snapshot_at < b.snapshot_at ? -1 : a.snapshot_at > b.snapshot_at ? 1 : 0
    );

  const byProvider = Array.from(perProvider.values()).sort((a, b) =>
    a.provider_name.localeCompare(b.provider_name)
  );

  let currentSnapshotAt: string | null = null;
  let currentTotal = 0;
  if (totals.length) {
    const latest = totals[totals.length - 1];
    currentSnapshotAt = latest.snapshot_at;
    currentTotal = latest.live_offer_count;
  }

  const response = c.json({
    window_hours: windowHours,
    totals,
    by_provider: byProvider,
    current_snapshot_at: currentSnapshotAt,
    current_total_live_offers: currentTotal,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 600, 3600);
});

// API key protection for extension-only endpoints.
// Requires matching x-extension-key header.
const protectedPaths = ["/analytics", "/offers", "/brand-domains", "/feedback", "/events"] as const;

for (const path of protectedPaths) {
  app.use(path, async (c, next) => {
    const expected = c.env.EXTENSION_API_KEY;
    if (!expected) {
      return c.json({ error: "Internal server error" }, 500);
    }
    const provided = c.req.header("x-extension-key") || "";
    if (provided !== expected) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });
}

// GET /brand-domains
// Returns a list of domains where the extension should call /offers.
// This is used by the extension to pre-filter which pages are eligible
// for offer lookups, and is safe to cache for a long time.
app.get("/brand-domains", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);

  const rows = await sql/* sql */ `
    select distinct lower(d) as domain
    from (
      select base_domain::text as d
      from brands
      where base_domain is not null
        and status = 'active'

      union

      select bd.domain::text as d
      from brand_domains bd
      join brands b on b.id = bd.brand_id
      where b.status = 'active'

      union

      select brd.domain::text as d
      from brand_redeemable_domains brd
      join brands b on b.id = brd.brand_id
      where b.status = 'active'
    ) all_domains
    order by domain
  `;

  const domains = (rows as any[]).map((r) => r.domain as string);

  const response = c.json({ domains });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 86400, 86400);
});

// POST /feedback
// Collects user feedback via Analytics Engine (no DB write).
app.post("/feedback", async (c) => {
  let body: {
    rating?: string;
    message?: string;
    extensionVersion?: string;
    browser?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { rating, message, extensionVersion, browser } = body;

  const feedbackEvent = {
    _time: new Date().toISOString(),
    event: "feedback",
    rating: rating ?? null,
    message: message ?? null,
    extension_version: extensionVersion ?? null,
    browser: browser ?? null,
  };

  if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
    c.executionCtx.waitUntil(ingestToAxiom(c.env, [feedbackEvent]));
  } else {
    await ingestToAxiom(c.env, [feedbackEvent]);
  }

  return c.json({ success: true });
});

// POST /events
// Records extension analytics events via Cloudflare Analytics Engine.
// No database writes - zero egress cost.
app.post("/events", async (c) => {
  const viewerId = c.req.header("x-viewer-id");
  if (!viewerId || !viewerId.trim()) {
    return c.json({ error: "Missing x-viewer-id header" }, 400);
  }

  let body: {
    eventType?: string;
    brandId?: string;
    providerId?: string;
    providerSlug?: string;
    domain?: string;
    productUrl?: string;
    discountPercent?: number;
    pageType?: string;
    extensionVersion?: string;
    browser?: string;
    metadata?: Record<string, unknown>;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { eventType } = body;
  if (!eventType) {
    return c.json({ error: "Missing eventType" }, 400);
  }

  const event = {
    _time: new Date().toISOString(),
    event: eventType,
    viewer_id: viewerId.trim(),
    brand_id: body.brandId ?? null,
    provider_id: body.providerId ?? null,
    provider_slug: body.providerSlug ?? null,
    domain: body.domain ?? null,
    product_url: body.productUrl ?? null,
    discount_percent: body.discountPercent ?? null,
    page_type: body.pageType ?? null,
    extension_version: body.extensionVersion ?? null,
    browser: body.browser ?? null,
    metadata: body.metadata ?? {},
  };

  if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
    c.executionCtx.waitUntil(ingestToAxiom(c.env, [event]));
  } else {
    await ingestToAxiom(c.env, [event]);
  }

  return c.json({ ok: true });
});

// GET /offers?domain=bestbuy.com[&in_store=true|false]
// Returns all provider offers for the brand matching the given base domain,
// plus a computed bestOffer for convenience. Optional in_store query param:
//   - in_store=true  → only in-store offers
//   - in_store=false → only non in-store offers
//   - omitted        → all offers (default)
app.get("/offers", async (c) => {
  const rawDomain = c.req.query("domain") || "";
  const domain = rawDomain.trim().toLowerCase();

  if (!domain) {
    return c.json({ error: "Missing required query param: domain" }, 400);
  }

  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);

  const inStoreParam = c.req.query("in_store");

  // Step 1: resolve the canonical brand for this hostname.
  // Prefer an explicit mapping in brand_domains; if none exists, fall back
  // to matching brands by base_domain.
  let canonicalBrandRows = await sql/* sql */ `
    select
      b.id,
      b.name,
      b.slug,
      b.base_domain
    from brand_domains bd
    join brands b on b.id = bd.brand_id
    where lower(bd.domain) = lower(${domain})
      and b.status = 'active'
    limit 1
  `;

  if (!canonicalBrandRows.length) {
    canonicalBrandRows = await sql/* sql */ `
      select
        b.id,
        b.name,
        b.slug,
        b.base_domain
      from brands b
      where lower(b.base_domain) = lower(${domain})
        and b.status = 'active'
      order by b.created_at
      limit 1
    `;
  }

  if (!canonicalBrandRows.length || !canonicalBrandRows[0]?.base_domain) {
    return c.json(
      {
        error: "Unsupported domain",
        brand: null,
        bestOffer: null,
        offers: [],
      },
      422
    );
  }

  const canonicalBrand = canonicalBrandRows[0] as any;
  const baseDomain = canonicalBrand.base_domain as string;

  const viewerIdHeader = c.req.header("x-viewer-id");
  const viewerId =
    typeof viewerIdHeader === "string" && viewerIdHeader.trim()
      ? viewerIdHeader.trim()
      : null;

  // Log brand view to Axiom (replaces brand_daily_viewers DB writes).
  if (viewerId) {
    const viewEvent = {
      _time: new Date().toISOString(),
      event: "view",
      viewer_id: viewerId,
      brand_id: canonicalBrand.id,
      brand_slug: canonicalBrand.slug,
      brand_name: canonicalBrand.name,
      domain,
    };
    if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
      c.executionCtx.waitUntil(ingestToAxiom(c.env, [viewEvent]));
    }
  }

  // Step 2: look up offers for:
  //   - all brands that share this base_domain (brand family, e.g. Gap + Baby Gap)
  //   - plus any brands whose gift cards are redeemable on this hostname
  const rows = await sql/* sql */ `
    select
      v.brand_id,
      v.brand_name,
      v.brand_slug,
      v.base_domain,
      v.provider_id,
      v.provider_name,
      v.provider_slug,
      v.max_discount_percent,
      v.in_stock,
      v.fetched_at,
      v.product_url,
      v.variant
    from v_brand_provider_offers v
    join brands b on b.id = v.brand_id
    where b.status = 'active'
      and (
        lower(b.base_domain) = lower(${baseDomain})
        or exists (
          select 1
          from brand_redeemable_domains brd
          where brd.brand_id = b.id
            and lower(brd.domain) = lower(${domain})
        )
      )
    order by
      v.in_stock desc,
      v.max_discount_percent desc nulls last,
      v.provider_name asc
  `;

  if (!rows.length) {
    return c.json({
      brand: null,
      bestOffer: null,
      offers: [],
    });
  }

  const brand = {
    id: canonicalBrand.id as string,
    name: canonicalBrand.name as string,
    slug: canonicalBrand.slug as string,
    base_domain: (canonicalBrand.base_domain as string | null) ?? null,
  };

  const offers = rows.map((r: any) => {
    const variant = (r.variant as string | null) ?? null;
    return {
      provider: {
        id: r.provider_id as string,
        name: r.provider_name as string,
        slug: r.provider_slug as string,
      },
      max_discount_percent:
        typeof r.max_discount_percent === "number"
          ? r.max_discount_percent
          : r.max_discount_percent != null
          ? Number(r.max_discount_percent)
          : null,
      in_stock: !!r.in_stock,
      fetched_at: r.fetched_at as string | null,
      product_url: r.product_url as string | null,
      variant,
      variant_label: variantToLabel(variant),
    };
  });

  // Optionally filter by in-store vs non in-store offers, based on query param.
  let filteredOffers = offers;
  if (inStoreParam != null) {
    const value = inStoreParam.toLowerCase();
    if (value === "true" || value === "1") {
      filteredOffers = offers.filter((o) => o.variant === "in_store");
    } else if (value === "false" || value === "0") {
      filteredOffers = offers.filter((o) => o.variant !== "in_store");
    }
  }

  // Filter to only offers that are both in stock and have a usable URL.
  const clickableOffers = filteredOffers.filter(
    (o) =>
      o.in_stock &&
      typeof o.product_url === "string" &&
      o.product_url &&
      o.max_discount_percent != null &&
      o.max_discount_percent > 0
  );

  // Best offer: first in-stock row by discount, with a non-empty URL
  // (thanks to SQL ordering, clickableOffers[0] is the best).
  const bestOffer = clickableOffers[0] || null;

  const response = c.json({
    brand,
    bestOffer,
    offers: clickableOffers,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, OFFERS_CLIENT_TTL_SECONDS, 15);
});

// GET /brands/:slug/discount-history
// Returns discount history for charting - both holistic max and per-provider
app.get("/brands/:slug/discount-history", async (c) => {
  const { cache, cacheKey, cached } = await getCached(c.req.url);
  if (cached) return cached;

  const sql = getDb(c.env);
  const slug = c.req.param("slug");

  // Parse query params
  const daysParam = c.req.query("days") || "30";
  const daysRaw = Number.parseInt(daysParam, 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;

  // Get brand by slug
  const brandRows = await sql/* sql */ `
    select id, name, slug
    from brands
    where slug = ${slug} and status = 'active'
    limit 1
  `;

  if (!brandRows.length) {
    return c.json({ error: "Brand not found" }, 404);
  }

  const brandId = (brandRows[0] as any).id;

  // Get discount history with provider info, aggregated per day.
  // Charts render at day-level granularity, so collapsing 15-min snapshots
  // into daily max(discount) cuts payload ~96x without changing what the
  // user sees.
  const historyRows = await sql/* sql */ `
    select
      h.provider_id,
      p.name as provider_name,
      p.slug as provider_slug,
      max(h.max_discount_percent) as max_discount_percent,
      bool_or(h.in_stock) as in_stock,
      date_trunc('day', h.observed_at)::date as observed_at
    from provider_brand_discount_history h
    join providers p on p.id = h.provider_id
    where h.brand_id = ${brandId}
      and h.observed_at >= now() - (${days} * interval '1 day')
    group by h.provider_id, p.name, p.slug, date_trunc('day', h.observed_at)::date
    order by date_trunc('day', h.observed_at)::date asc
  `;

  type HistoryRow = {
    provider_id: string;
    provider_name: string;
    provider_slug: string;
    max_discount_percent: number | string;
    in_stock: boolean;
    observed_at: string;
  };

  const history = historyRows as any as HistoryRow[];

  // Build per-provider history
  const providerMap = new Map<string, {
    provider_id: string;
    provider_name: string;
    provider_slug: string;
    data: { date: string; discount: number; in_stock: boolean }[];
  }>();

  for (const row of history) {
    const discount = typeof row.max_discount_percent === "number"
      ? row.max_discount_percent
      : Number(row.max_discount_percent);

    if (!providerMap.has(row.provider_id)) {
      providerMap.set(row.provider_id, {
        provider_id: row.provider_id,
        provider_name: row.provider_name,
        provider_slug: row.provider_slug,
        data: [],
      });
    }

    providerMap.get(row.provider_id)!.data.push({
      date: new Date(row.observed_at).toISOString().split("T")[0],
      discount,
      in_stock: row.in_stock,
    });
  }

  // Helper: generate all dates in range
  function generateDateRange(startDate: Date, endDate: Date): string[] {
    const dates: string[] = [];
    const current = new Date(startDate);
    while (current <= endDate) {
      dates.push(current.toISOString().split("T")[0]);
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }

  // Helper: fill gaps with last known value (carry-forward)
  function fillGaps(
    data: { date: string; discount: number; in_stock: boolean }[],
    allDates: string[]
  ): { date: string; discount: number; in_stock: boolean }[] {
    if (data.length === 0) return [];

    const dataMap = new Map(data.map((d) => [d.date, d]));
    const filled: { date: string; discount: number; in_stock: boolean }[] = [];
    let lastKnown: { discount: number; in_stock: boolean } | null = null;

    for (const date of allDates) {
      const existing = dataMap.get(date);
      if (existing) {
        filled.push(existing);
        lastKnown = { discount: existing.discount, in_stock: existing.in_stock };
      } else if (lastKnown) {
        // Carry forward last known value
        filled.push({ date, ...lastKnown });
      }
      // If no lastKnown yet, skip (we don't have data before the first point)
    }

    return filled;
  }

  // Generate full date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const allDates = generateDateRange(startDate, endDate);

  // Fill gaps for each provider
  const providers = Array.from(providerMap.values()).map((provider) => ({
    ...provider,
    data: fillGaps(provider.data, allDates),
  }));

  // Build holistic max discount per day (from filled provider data)
  const dailyMaxMap = new Map<string, number>();
  for (const provider of providers) {
    for (const d of provider.data) {
      if (!dailyMaxMap.has(d.date) || d.discount > dailyMaxMap.get(d.date)!) {
        dailyMaxMap.set(d.date, d.discount);
      }
    }
  }

  // If no provider data, fall back to raw history
  if (dailyMaxMap.size === 0) {
    for (const row of history) {
      const date = new Date(row.observed_at).toISOString().split("T")[0];
      const discount = typeof row.max_discount_percent === "number"
        ? row.max_discount_percent
        : Number(row.max_discount_percent);

      if (!dailyMaxMap.has(date) || discount > dailyMaxMap.get(date)!) {
        dailyMaxMap.set(date, discount);
      }
    }
  }

  // Fill holistic gaps too
  const holisticRaw = Array.from(dailyMaxMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, discount]) => ({ date, discount, in_stock: true }));

  const holisticFilled = fillGaps(holisticRaw, allDates);
  const holistic = holisticFilled.map(({ date, discount }) => ({ date, discount }));

  const response = c.json({
    brand_id: brandId,
    days,
    holistic,
    providers,
  });

  return cacheResponse(response, cache, cacheKey, c.executionCtx, 21600, 43200);
});

// Scheduled handler: compute popular brands from Axiom → KV.
// Runs every 15 minutes (configured in wrangler.jsonc triggers.crons).
async function handleScheduled(env: Env) {
  const kv = env.KV;
  if (!kv) {
    console.error("[cron] KV binding not available");
    return;
  }

  const token = env.AXIOM_TOKEN;
  const dataset = env.AXIOM_DATASET;

  if (!token || !dataset) {
    console.warn("[cron] AXIOM_TOKEN or AXIOM_DATASET not set, using DB fallback");
    await computePopularBrandsFromDb(env, kv);
    return;
  }

  try {
    // APL query: top brands by view count in last 24h, combining extension + website views.
    // Group by brand_slug (present in both sources). brand_id is only set by extension.
    const apl = `['${dataset}']
| where event == 'view'
| where _time > ago(24h)
| where isnotnull(brand_slug) and brand_slug != ''
| summarize view_count = count() by brand_slug
| order by view_count desc
| take 100`;

    const resp = await fetch("https://api.axiom.co/v1/datasets/_apl/query?format=tabular", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apl }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[cron] Axiom query failed:", resp.status, errText);
      await computePopularBrandsFromDb(env, kv);
      return;
    }

    const result = await resp.json() as {
      tables?: Array<{
        columns: string[];
        rows?: Array<Array<unknown>>;
      }>;
    };

    const table = result.tables?.[0];
    const columns = table?.columns ?? [];
    const rows = table?.rows ?? [];

    const brandSlugIdx = columns.indexOf("brand_slug");
    const viewCountIdx = columns.indexOf("view_count");

    const axiomRows: Array<{ brand_slug: string; view_count: number }> =
      rows.map((row) => ({
        brand_slug: String(row[brandSlugIdx] ?? ""),
        view_count: Number(row[viewCountIdx] ?? 0),
      })).filter((r) => r.brand_slug);

    if (axiomRows.length === 0) {
      console.warn("[cron] No Axiom data yet, falling back to DB");
      await computePopularBrandsFromDb(env, kv);
      return;
    }

    // Enrich with current discount data from Supabase, matched by slug
    const sql = getDb(env);
    const slugs = axiomRows.map((r) => r.brand_slug);

    const discountRows = await sql/* sql */ `
      select
        b.id as brand_id,
        b.name,
        b.slug,
        b.base_domain,
        max(pbd.max_discount_percent) as max_discount,
        c.name as category_name
      from provider_brand_discounts pbd
      join brands b on b.id = pbd.brand_id
      left join categories c on c.id = b.category_id
      where pbd.in_stock = true
        and b.status = 'active'
        and b.slug = any(${slugs})
      group by b.id, b.name, b.slug, b.base_domain, c.name
    `;

    const discountMap = new Map<string, any>();
    for (const r of discountRows as any[]) {
      discountMap.set(r.slug, r);
    }

    const brands = axiomRows
      .filter((r) => discountMap.has(r.brand_slug))
      .map((r) => {
        const d = discountMap.get(r.brand_slug)!;
        return {
          id: d.brand_id as string,
          name: d.name as string,
          slug: d.slug as string,
          base_domain: (d.base_domain as string | null) ?? null,
          category_name: (d.category_name as string | null) ?? null,
          event_count: r.view_count,
          max_discount_percent:
            typeof d.max_discount === "number" ? d.max_discount : Number(d.max_discount) || 0,
        };
      });

    await kv.put(
      "popular-brands",
      JSON.stringify({
        window_hours: 24,
        brands,
        computed_at: new Date().toISOString(),
      }),
      { expirationTtl: 3600 }
    );

    console.log(`[cron] Computed popular brands from Axiom: ${brands.length} brands`);
  } catch (err) {
    console.error("[cron] Error computing popular brands:", err);
    await computePopularBrandsFromDb(env, kv);
  }
}

// Fallback: compute popular brands from DB (top discounts, no viewer data needed)
async function computePopularBrandsFromDb(env: Env, kv: KVNamespace) {
  try {
    const sql = getDb(env);
    const rows = await sql/* sql */ `
      select distinct on (b.id)
        b.id as brand_id,
        b.name,
        b.slug,
        b.base_domain,
        pbd.max_discount_percent,
        c.name as category_name
      from provider_brand_discounts pbd
      join brands b on b.id = pbd.brand_id
      left join categories c on c.id = b.category_id
      where pbd.in_stock = true
        and b.status = 'active'
        and pbd.max_discount_percent > 0
      order by b.id, pbd.max_discount_percent desc
      limit 100
    `;

    const brands = (rows as any[]).map((r) => ({
      id: r.brand_id as string,
      name: r.name as string,
      slug: r.slug as string,
      base_domain: (r.base_domain as string | null) ?? null,
      category_name: (r.category_name as string | null) ?? null,
      event_count: 0,
      max_discount_percent:
        typeof r.max_discount_percent === "number"
          ? r.max_discount_percent
          : Number(r.max_discount_percent) || 0,
    }));

    await kv.put(
      "popular-brands",
      JSON.stringify({
        window_hours: 24,
        brands,
        computed_at: new Date().toISOString(),
        source: "db_fallback",
      }),
      { expirationTtl: 3600 }
    );

    console.log(`[cron] Computed popular brands from DB fallback: ${brands.length} brands`);
  } catch (err) {
    console.error("[cron] DB fallback also failed:", err);
  }
}

// POST /internal/compute-popular-brands
// Triggered by GitHub Actions cron. Protected by Bearer token (CRON_SECRET).
app.post("/internal/compute-popular-brands", async (c) => {
  const authHeader = c.req.header("authorization") || "";
  const expected = `Bearer ${c.env.CRON_SECRET ?? ""}`;
  if (!c.env.CRON_SECRET || authHeader !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await handleScheduled(c.env);
  return c.json({ ok: true });
});

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ) {
    return app.fetch(request, env, ctx as any);
  },

  async scheduled(
    _event: { cron: string; scheduledTime: number },
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ) {
    ctx.waitUntil(handleScheduled(env));
  },
};
