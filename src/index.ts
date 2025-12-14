import { Hono } from "hono";
import { getDb } from "./db.ts";

type Env = {
  DATABASE_URL: string;
  EXTENSION_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

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
    order by event_count desc
    limit ${limit}
  `;

  const brands = (rows as any[]).map((r) => ({
    id: r.brand_id as string,
    name: r.name as string,
    slug: r.slug as string,
    base_domain: (r.base_domain as string | null) ?? null,
    event_count:
      typeof r.event_count === "number" ? r.event_count : Number(r.event_count),
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
  brands.sort(
    (a, b) => b.delta_discount_percent - a.delta_discount_percent
  );
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
      typeof r.view_count === "number"
        ? r.view_count
        : Number(r.view_count),
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
          console.error(
            "Error caching /analytics/live-offers response:",
            err
          );
        }
      })()
    );
  }

  return response;
});

// Simple API key protection. If EXTENSION_API_KEY is configured in the Worker
// environment, require matching X-Extension-Key for analytics and offers traffic.
app.use("/analytics", async (c, next) => {
  const expected = c.env.EXTENSION_API_KEY;
  if (!expected) {
    return c.json(
      { error: "Server misconfigured: missing EXTENSION_API_KEY" },
      500
    );
  }
  const provided = c.req.header("x-extension-key") || "";
  if (provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

app.use("/offers", async (c, next) => {
  const expected = c.env.EXTENSION_API_KEY;
  if (!expected) {
    return c.json(
      { error: "Server misconfigured: missing EXTENSION_API_KEY" },
      500
    );
  }
  const provided = c.req.header("x-extension-key") || "";
  if (provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

app.use("/brand-domains", async (c, next) => {
  const expected = c.env.EXTENSION_API_KEY;
  if (!expected) {
    return c.json(
      { error: "Server misconfigured: missing EXTENSION_API_KEY" },
      500
    );
  }
  const provided = c.req.header("x-extension-key") || "";
  if (provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

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
