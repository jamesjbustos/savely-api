import { Hono } from "hono";
import { getDb } from "./db";
import {
  runArbitrageCron,
  runCardCenterCron,
  runCardCookieCron,
  runCardDepotCron,
  runGcxCron,
} from "./cron";

type Env = {
  DATABASE_URL: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));

// GET /offers?domain=bestbuy.com
// Returns all provider offers for the brand matching the given base domain,
// plus a computed bestOffer for convenience.
app.get("/offers", async (c) => {
  const rawDomain = c.req.query("domain") || "";
  const domain = rawDomain.trim().toLowerCase();

  if (!domain) {
    return c.json({ error: "Missing required query param: domain" }, 400);
  }

  const sql = getDb(c.env);

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

  const offers = rows.map((r: any) => ({
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
    variant: r.variant as string | null,
  }));

  // Best offer: first in-stock row by discount (thanks to SQL ordering)
  const bestOffer = offers.find((o) => o.in_stock) || null;

  return c.json({
    brand,
    bestOffer,
    offers,
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
  scheduled(
    controller: { cron?: string },
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ) {
    // Run provider syncs in the background when the cron trigger fires.
    // We differentiate schedules using the cron expression:
    // - "*/30 * * * *"   -> fast lane: CardCenter, CardDepot, CardCookie, GCX
    // - "0 */8 * * *"    -> slow lane: ArbitrageCard (every 8 hours)
    if (controller.cron === "*/30 * * * *") {
      ctx.waitUntil(
        Promise.all([
          runCardCenterCron(env),
          runCardDepotCron(env),
          runCardCookieCron(env),
          runGcxCron(env),
        ])
      );
    } else if (controller.cron === "0 */8 * * *") {
      ctx.waitUntil(runArbitrageCron(env));
    } else {
      // Fallback: run the fast-lane providers
      ctx.waitUntil(
        Promise.all([
          runCardCenterCron(env),
          runCardDepotCron(env),
          runCardCookieCron(env),
          runGcxCron(env),
        ])
      );
    }
  },
};
