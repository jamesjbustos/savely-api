import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb } from "./db.ts";

type Env = {
  DATABASE_URL: string;
  EXTENSION_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

// CORS — allow the web app and local dev origins.
// The browser extension uses background-script fetch (no CORS restrictions).
app.use(
  "*",
  cors({
    origin: [
      "https://trysavely.com",
      "https://www.trysavely.com",
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

const OFFERS_CACHE_TTL_MS = 30_000;
const OFFERS_CLIENT_TTL_SECONDS = 30;
const ANALYTICS_CACHE_TTL_MS = 60_000;

function getOffersCache() {
  const globalCaches = (globalThis as any).caches;
  if (!globalCaches || !globalCaches.default) return null;
  return globalCaches.default as {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
}

function variantToLabel(variant: string | null | undefined): string | null {
  if (!variant) return null;
  if (variant === "online") return "Online";
  if (variant === "in_store") return "In-store only";
  return null; // "other" → no label
}

app.get("/health", (c) => c.text("ok"));

// GET /brands
// Public directory of brands with their best available discount.
// Supports optional search, discount filtering, sorting, and pagination.
app.get("/brands", async (c) => {
  const sql = getDb(c.env);

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < ANALYTICS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

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
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), 100)
    : 24;

  const rows = await sql/* sql */ `
    with brand_views as (
      select
        v.brand_id,
        count(*) as view_count
      from brand_daily_viewers v
      where v.created_at >= now() - interval '30 days'
      group by v.brand_id
    ),
    latest_deal_change as (
      select
        brand_id,
        max(observed_at) as last_deal_updated
      from provider_brand_discount_history
      group by brand_id
    )
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
      coalesce(bv.view_count, 0) as view_count,
      c.id as category_id,
      c.name as category_name,
      c.slug as category_slug
    from v_brand_provider_offers v
    join brands b on b.id = v.brand_id
    left join brand_views bv on bv.brand_id = v.brand_id
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
      bv.view_count,
      c.id,
      c.name,
      c.slug
    having
      (${useMinDiscount} = false or max(v.max_discount_percent) >= ${minDiscount})
      and (${useMaxDiscount} = false or max(v.max_discount_percent) <= ${maxDiscount})
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
    view_count: number | string | null;
    category_id: string | null;
    category_name: string | null;
    category_slug: string | null;
  };

  let brands = (rows as any as Row[]).map((r) => {
    const bestDiscount =
      r.best_discount == null
        ? null
        : typeof r.best_discount === "number"
        ? r.best_discount
        : Number(r.best_discount);
    const viewCountRaw = r.view_count;
    const viewCount =
      typeof viewCountRaw === "number"
        ? viewCountRaw
        : viewCountRaw == null
        ? 0
        : Number(viewCountRaw);

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
      base_domain: (r.base_domain as string | null) ?? null,
      description: r.brand_description ?? null,
      created_at: r.brand_created_at ?? null,
      last_deal_updated: r.last_deal_updated ?? null,
      max_discount_percent: bestDiscount,
      in_stock: !!r.in_stock,
      view_count: viewCount,
      category,
    };
  });

  if (sortParam === "newest") {
    // Sort by last_deal_updated descending (recently changed deals first)
    brands.sort((a, b) => {
      const aRaw = a.last_deal_updated || a.created_at;
      const bRaw = b.last_deal_updated || b.created_at;
      const aDate = aRaw instanceof Date ? aRaw.toISOString() : (aRaw || "");
      const bDate = bRaw instanceof Date ? bRaw.toISOString() : (bRaw || "");
      if (bDate !== aDate) return bDate.localeCompare(aDate);
      return a.name.localeCompare(b.name);
    });
  } else if (sortParam === "discount_desc") {
    brands.sort((a, b) => {
      const ad = a.max_discount_percent ?? 0;
      const bd = b.max_discount_percent ?? 0;
      if (bd !== ad) return bd - ad;
      return a.name.localeCompare(b.name);
    });
  } else if (sortParam === "discount_asc") {
    brands.sort((a, b) => {
      const ad = a.max_discount_percent ?? 0;
      const bd = b.max_discount_percent ?? 0;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
  } else if (sortParam === "relevance") {
    brands.sort((a, b) => {
      const av = a.view_count ?? 0;
      const bv = b.view_count ?? 0;
      if (bv !== av) return bv - av;
      const ad = a.max_discount_percent ?? 0;
      const bd = b.max_discount_percent ?? 0;
      if (bd !== ad) return bd - ad;
      return a.name.localeCompare(b.name);
    });
  } else {
    // default A–Z
    brands.sort((a, b) => a.name.localeCompare(b.name));
  }

  const total = brands.length;
  const start = (page - 1) * pageSize;
  const paginated =
    start >= 0 && start < total ? brands.slice(start, start + pageSize) : [];

  const response = c.json({
    page,
    page_size: pageSize,
    total,
    brands: paginated,
  });

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error("Error caching /brands response:", err);
        }
      })()
    );
  }

  return response;
});

// GET /brands/:slug
// Public detail view for a single brand and its provider offers.
app.get("/brands/:slug", async (c) => {
  const sql = getDb(c.env);

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < ANALYTICS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

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

  const offersAll = (offerRows as any as OfferRow[]).map((r) => {
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

  const clickableOffers = offersAll.filter(
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

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error("Error caching /brands/:slug response:", err);
        }
      })()
    );
  }

  return response;
});

// GET /categories
// Returns all categories with computed brand counts and max discounts.
app.get("/categories", async (c) => {
  const sql = getDb(c.env);

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < ANALYTICS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

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
      join provider_brand_discounts pbd on pbd.brand_id = b.id
      where b.status = 'active'
        and b.category_id is not null
        and pbd.in_stock = true
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

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error("Error caching /categories response:", err);
        }
      })()
    );
  }

  return response;
});

// GET /categories/:slug
// Returns single category with paginated brands.
app.get("/categories/:slug", async (c) => {
  const sql = getDb(c.env);

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < ANALYTICS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

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

  const pageRaw = Number.parseInt(pageParam, 10);
  const pageSizeRaw = Number.parseInt(pageSizeParam, 10);

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), 100)
    : 24;
  const offset = (page - 1) * pageSize;

  const statsRow = await sql/* sql */ `
    select
      count(distinct b.id) as total,
      max(pbd.max_discount_percent) as max_discount
    from brands b
    left join provider_brand_discounts pbd on pbd.brand_id = b.id and pbd.in_stock = true
    where b.category_id = ${categoryRow.id}
      and b.status = 'active'
  `;

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

  const brandRows = await sql/* sql */ `
    select
      b.id,
      b.name,
      b.slug,
      b.base_domain,
      max(pbd.max_discount_percent) as max_discount_percent,
      bool_or(pbd.in_stock) as in_stock
    from brands b
    left join provider_brand_discounts pbd on pbd.brand_id = b.id
    where b.category_id = ${categoryRow.id}
      and b.status = 'active'
    group by b.id, b.name, b.slug, b.base_domain
    order by b.name asc
    limit ${pageSize}
    offset ${offset}
  `;

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

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error("Error caching /categories/:slug response:", err);
        }
      })()
    );
  }

  return response;
});

// GET /popular-brands?window_hours=24&limit=20
// Returns brands ordered by how many unique viewers they had
// in the last N hours (default 24), based solely on brand_daily_viewers.
app.get("/popular-brands", async (c) => {
  const sql = getDb(c.env);

  const windowParam = c.req.query("window_hours") || "24";
  const limitParam = c.req.query("limit") || "20";

  const windowHoursRaw = Number.parseInt(windowParam, 10);
  const limitRaw = Number.parseInt(limitParam, 10);

  const windowHours = Number.isFinite(windowHoursRaw)
    ? Math.min(Math.max(windowHoursRaw, 1), 168)
    : 24;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 20;

  const rows = await sql/* sql */ `
    with brand_views as (
      select
        b.id as brand_id,
        b.name,
        b.slug,
        b.base_domain,
        count(*) as event_count
      from brand_daily_viewers v
      join brands b on b.id = v.brand_id
      where v.created_at >= now() - (${windowHours} * interval '1 hour')
      group by b.id, b.name, b.slug, b.base_domain
    ),
    brand_discounts as (
      select
        pbd.brand_id,
        max(pbd.max_discount_percent) as max_discount
      from provider_brand_discounts pbd
      where pbd.in_stock = true
      group by pbd.brand_id
    )
    select
      bv.brand_id,
      bv.name,
      bv.slug,
      bv.base_domain,
      bv.event_count,
      coalesce(bd.max_discount, 0) as max_discount_percent
    from brand_views bv
    left join brand_discounts bd on bd.brand_id = bv.brand_id
    order by bv.event_count desc
    limit ${limit}
  `;

  const brands = (rows as any[]).map((r) => ({
    id: r.brand_id as string,
    name: r.name as string,
    slug: r.slug as string,
    base_domain: (r.base_domain as string | null) ?? null,
    event_count:
      typeof r.event_count === "number" ? r.event_count : Number(r.event_count),
    max_discount_percent:
      typeof r.max_discount_percent === "number"
        ? r.max_discount_percent
        : Number(r.max_discount_percent) || 0,
  }));

  return c.json({
    window_hours: windowHours,
    limit,
    brands,
  });
});

// GET /analytics/biggest-price-drops?window_hours=24&limit=20
// Biggest positive changes in max discount over the window, aggregated per brand.
app.get("/analytics/biggest-price-drops", async (c) => {
  const sql = getDb(c.env);

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < ANALYTICS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

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

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error(
            "Error caching /analytics/biggest-price-drops response:",
            err
          );
        }
      })()
    );
  }

  return response;
});

// GET /analytics/popular-giftcards?window_hours=24&limit=20
// Popular brands based on recent viewers, restricted to brands that currently
// have live offers, and annotated with best current discount.
app.get("/analytics/popular-giftcards", async (c) => {
  const sql = getDb(c.env);

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < ANALYTICS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

  const windowParam = c.req.query("window_hours") || "24";
  const limitParam = c.req.query("limit") || "20";

  const windowHoursRaw = Number.parseInt(windowParam, 10);
  const limitRaw = Number.parseInt(limitParam, 10);

  const windowHours = Number.isFinite(windowHoursRaw)
    ? Math.min(Math.max(windowHoursRaw, 1), 168)
    : 24;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 20;

  const rows = await sql/* sql */ `
    with base_popular as (
      select
        b.id as brand_id,
        b.name as brand_name,
        b.slug as brand_slug,
        b.base_domain,
        count(*) as view_count
      from brand_daily_viewers v
      join brands b on b.id = v.brand_id
      where v.created_at >= now() - (${windowHours} * interval '1 hour')
      group by b.id, b.name, b.slug, b.base_domain
    ),
    brand_best_discounts as (
      select
        v.brand_id,
        max(v.max_discount_percent) as best_discount
      from v_brand_provider_offers v
      join brands b on b.id = v.brand_id
      where v.in_stock = true
        and b.status = 'active'
      group by v.brand_id
    )
    select
      p.brand_id,
      p.brand_name,
      p.brand_slug,
      p.base_domain,
      p.view_count,
      d.best_discount
    from base_popular p
    join brand_best_discounts d on d.brand_id = p.brand_id
    order by p.view_count desc
    limit ${limit}
  `;

  type Row = {
    brand_id: string;
    brand_name: string;
    brand_slug: string;
    base_domain: string | null;
    view_count: number | string;
    best_discount: number | string | null;
  };

  const brands = (rows as any as Row[]).map((r) => ({
    brand_id: r.brand_id,
    brand_name: r.brand_name,
    brand_slug: r.brand_slug,
    base_domain: (r.base_domain as string | null) ?? null,
    view_count:
      typeof r.view_count === "number" ? r.view_count : Number(r.view_count),
    best_discount_percent:
      r.best_discount == null
        ? null
        : typeof r.best_discount === "number"
        ? r.best_discount
        : Number(r.best_discount),
  }));

  const response = c.json({
    window_hours: windowHours,
    limit,
    brands,
  });

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error(
            "Error caching /analytics/popular-giftcards response:",
            err
          );
        }
      })()
    );
  }

  return response;
});

// GET /analytics/top-discounts?limit=20
// Highest current discounts per brand (best offer per brand).
app.get("/analytics/top-discounts", async (c) => {
  const sql = getDb(c.env);

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < ANALYTICS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

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

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error(
            "Error caching /analytics/top-discounts response:",
            err
          );
        }
      })()
    );
  }

  return response;
});

// GET /analytics/live-offers?window_hours=168
// Returns time series of live offers based on offer_inventory_snapshots:
//  - totals: summed live offers across all providers per snapshot_at
//  - by_provider: per-provider series with provider metadata
app.get("/analytics/live-offers", async (c) => {
  const sql = getDb(c.env);

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < ANALYTICS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

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

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error("Error caching /analytics/live-offers response:", err);
        }
      })()
    );
  }

  return response;
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

  c.header("Cache-Control", "public, max-age=86400");

  return c.json({ domains });
});

// POST /feedback
// Collects user feedback from the browser extension.
app.post("/feedback", async (c) => {
  const sql = getDb(c.env);

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

  await sql/* sql */ `
    INSERT INTO user_feedback (rating, message, extension_version, browser)
    VALUES (${rating ?? null}, ${message ?? null}, ${
    extensionVersion ?? null
  }, ${browser ?? null})
  `;

  return c.json({ success: true });
});

// POST /events
// Records extension analytics events (clicks, impressions, etc.)
app.post("/events", async (c) => {
  const sql = getDb(c.env);

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

  const metadataJson =
    body.metadata && Object.keys(body.metadata).length > 0
      ? JSON.stringify(body.metadata)
      : "{}";

  // Fire-and-forget insert
  const insertEvent = async () => {
    try {
      await sql/* sql */ `
        INSERT INTO extension_events (
          viewer_id, event_type, brand_id, provider_id, provider_slug,
          domain, product_url, discount_percent, page_type, extension_version, browser, metadata
        ) VALUES (
          ${viewerId.trim()},
          ${eventType},
          ${body.brandId ?? null},
          ${body.providerId ?? null},
          ${body.providerSlug ?? null},
          ${body.domain ?? null},
          ${body.productUrl ?? null},
          ${body.discountPercent ?? null},
          ${body.pageType ?? null},
          ${body.extensionVersion ?? null},
          ${body.browser ?? null},
          ${metadataJson}::jsonb
        )
      `;
    } catch (err) {
      console.error("Error inserting extension_event:", err);
    }
  };

  if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
    c.executionCtx.waitUntil(insertEvent());
  } else {
    await insertEvent();
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

  const cache = getOffersCache();
  const cacheKey = cache ? new Request(c.req.url, { method: "GET" }) : null;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedAtHeader = cached.headers.get("X-Savely-Cache-At");
      const cachedAt = cachedAtHeader ? Number(cachedAtHeader) : 0;
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < OFFERS_CACHE_TTL_MS
      ) {
        return cached;
      }
    }
  }

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

  // Fire-and-forget analytics for extension traffic hitting a known brand.
  // Only log unique daily viewers when a viewer_id is provided.
  const logBrandEvent = async () => {
    if (!viewerId) return;
    try {
      await sql/* sql */ `
        insert into brand_daily_viewers (brand_id, viewer_id, day)
        values (${canonicalBrand.id}, ${viewerId}, current_date)
        on conflict (brand_id, viewer_id, day) do nothing
      `;
    } catch (err) {
      console.error("Error logging brand_daily_viewers entry:", err);
    }
  };

  if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
    c.executionCtx.waitUntil(logBrandEvent());
  } else {
    await logBrandEvent();
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

  response.headers.set(
    "X-Savely-Offers-TTL-Seconds",
    String(OFFERS_CLIENT_TTL_SECONDS)
  );

  if (cache && cacheKey && c.executionCtx && c.executionCtx.waitUntil) {
    response.headers.set("X-Savely-Cache-At", String(Date.now()));
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, response.clone());
        } catch (err) {
          console.error("Error caching /offers response:", err);
        }
      })()
    );
  }

  return response;
});

// GET /brands/:slug/discount-history
// Returns discount history for charting - both holistic max and per-provider
app.get("/brands/:slug/discount-history", async (c) => {
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

  // Get discount history with provider info
  const historyRows = await sql/* sql */ `
    select
      h.provider_id,
      p.name as provider_name,
      p.slug as provider_slug,
      h.max_discount_percent,
      h.in_stock,
      h.observed_at
    from provider_brand_discount_history h
    join providers p on p.id = h.provider_id
    where h.brand_id = ${brandId}
      and h.observed_at >= now() - (${days} * interval '1 day')
    order by h.observed_at asc
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

  return c.json({
    brand_id: brandId,
    days,
    holistic,
    providers,
  });
});

export default {
  // Use minimal types for the platform context objects to avoid depending on
  // Cloudflare's global TypeScript types in this entry file.
  fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ) {
    return app.fetch(request, env, ctx as any);
  },
};
