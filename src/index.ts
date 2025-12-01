import { Hono } from "hono";
import { getDb } from "./db.ts";

type Env = {
  DATABASE_URL: string;
  EXTENSION_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

const OFFERS_CACHE_TTL_MS = 30_000;

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
// Returns brands ordered by how many relevant events they had
// in the last N hours (default 24), based on brand_events.
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
    from brand_events e
    join brands b on b.id = e.brand_id
    where e.event_type = 'offer_view'
      and e.created_at >= now() - (${windowHours} * interval '1 hour')
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
      typeof r.event_count === "number"
        ? r.event_count
        : Number(r.event_count),
  }));

  return c.json({
    window_hours: windowHours,
    limit,
    brands,
  });
});

// Simple API key protection for extension traffic. If EXTENSION_API_KEY is
// configured in the Worker environment, require matching X-Extension-Key.
app.use("/offers", async (c, next) => {
  const expected = c.env.EXTENSION_API_KEY;
  if (!expected) {
    return c.json({ error: "Server misconfigured: missing EXTENSION_API_KEY" }, 500);
  }
  const provided = c.req.header("x-extension-key") || "";
  if (provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
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
    return c.json({
      brand: null,
      bestOffer: null,
      offers: [],
    });
  }

  const canonicalBrand = canonicalBrandRows[0] as any;
  const baseDomain = canonicalBrand.base_domain as string;

  // Fire-and-forget analytics event for extension traffic hitting a known brand.
  // Only log when the domain maps to a brand in our DB.
  const logBrandEvent = async () => {
    try {
      await sql/* sql */ `
        insert into brand_events (brand_id, event_type, source, domain)
        values (${canonicalBrand.id}, ${"offer_view"}, ${"extension"}, ${domain})
      `;
    } catch (err) {
      console.error("Error logging brand_events entry:", err);
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
