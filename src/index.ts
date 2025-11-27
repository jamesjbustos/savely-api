import { Hono } from "hono";
import { getDb } from "./db.ts";

type Env = {
  DATABASE_URL: string;
};

const app = new Hono<{ Bindings: Env }>();

function variantToLabel(variant: string | null | undefined): string | null {
  if (!variant) return null;
  if (variant === "online") return "Online";
  if (variant === "in_store") return "In-store only";
  return null; // "other" → no label
}

app.get("/health", (c) => c.text("ok"));

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

  const sql = getDb(c.env);

  const inStoreParam = c.req.query("in_store");

  // Look up offers via the materialized view, restricted to active brands
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
    where lower(b.base_domain) = lower(${domain})
      and b.status = 'active'
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

  const first = rows[0] as any;

  const brand = {
    id: first.brand_id as string,
    name: first.brand_name as string,
    slug: first.brand_slug as string,
    base_domain: first.base_domain as string | null,
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
    (o) => o.in_stock && typeof o.product_url === "string" && o.product_url
  );

  // Best offer: first in-stock row by discount, with a non-empty URL
  // (thanks to SQL ordering, clickableOffers[0] is the best).
  const bestOffer = clickableOffers[0] || null;

  return c.json({
    brand,
    bestOffer,
    offers: clickableOffers,
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
