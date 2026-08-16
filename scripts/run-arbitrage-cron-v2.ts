/**
 * ArbitrageCard ingest, rewritten for their WooCommerce/WordPress API.
 *
 * WHY THIS WAS REWRITTEN
 *
 * The previous version called the legacy per-brand endpoint:
 *   /wp-json/arbitragecard/v1/available-gift-cards?merchant_domain=<domain>
 * once for every brand, and selected those brands with:
 *   join provider_brand_products p ... where p.provider_id = arbitragecard
 *
 * That join is circular: it only refreshes brands ALREADY linked to
 * ArbitrageCard, so it can never discover a new one. In production it was
 * checking 23 brands and reporting 0 in stock, while the site actually had
 * 553 cards across 109 domains live.
 *
 * The site now exposes a bulk endpoint under a new namespace:
 *   /wp-json/arbitrage-card/v1/gift-cards   (note the hyphen)
 * which returns the whole inventory in one request, with richer fields:
 *   { cardId, merchantId, brandName, domain, value, price,
 *     discountPercentage, quantity, cardType, url }
 *
 * One request replaces N, we match on domain instead of a self-referential
 * join, and quantity gives real stock rather than an availability flag.
 * Those 109 domains match 118 brands in our catalogue.
 *
 * The legacy endpoint still responds, so this is a capability upgrade rather
 * than a break-fix - but it has been returning available:0 for everything,
 * which is why ArbitrageCard showed no inventory at all.
 */
import postgres from "postgres";

const GIFT_CARDS_URL =
  "https://arbitragecard.com/wp-json/arbitrage-card/v1/gift-cards";
const UA =
  "Mozilla/5.0 (compatible; CardDealsBot/1.0; +https://carddeals.co)";

type GiftCard = {
  cardId?: string;
  merchantId?: number;
  brandName?: string;
  domain?: string;
  value?: number;
  price?: number;
  discountPercentage?: number;
  quantity?: number;
  cardType?: string;
  url?: string;
};

/** Append our UTMs, matching the convention used by the other provider crons. */
function withUtm(rawUrl: string, brandDomain: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set("utm_source", "carddeals");
    u.searchParams.set("utm_medium", "referral");
    u.searchParams.set("utm_campaign", brandDomain);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error("DATABASE_URL is required");
  const sql = postgres(dsn, { prepare: false, max: 1 });

  const res = await fetch(GIFT_CARDS_URL, {
    headers: { accept: "application/json", "user-agent": UA },
  });
  if (!res.ok) {
    throw new Error(`ArbitrageCard feed returned ${res.status}`);
  }
  const payload = (await res.json()) as { updateTime?: string; giftCards?: GiftCard[] };
  const cards = payload.giftCards ?? [];
  console.log(
    `Arbitrage cron: feed updateTime=${payload.updateTime ?? "?"}, ${cards.length} cards`
  );
  if (!cards.length) {
    // Never blank the catalogue on an empty feed - that would mark every brand
    // out of stock on a transient upstream problem.
    console.warn("Arbitrage cron: feed returned no cards; leaving existing rows untouched");
    await sql.end();
    return;
  }

  // Collapse per-value variants down to one row per domain: best discount,
  // total quantity, and a URL pointing at the best-discounted variant.
  const byDomain = new Map<
    string,
    { maxDiscount: number; qty: number; url: string | null; name: string; merchantId: number | null }
  >();
  for (const c of cards) {
    const domain = (c.domain ?? "").trim().toLowerCase();
    if (!domain) continue;
    const disc = Number(c.discountPercentage ?? 0) || 0;
    const qty = Number(c.quantity ?? 0) || 0;
    const cur = byDomain.get(domain);
    if (!cur) {
      byDomain.set(domain, {
        maxDiscount: disc,
        qty,
        url: c.url ?? null,
        name: c.brandName ?? domain,
        merchantId: c.merchantId ?? null,
      });
    } else {
      cur.qty += qty;
      if (disc > cur.maxDiscount) {
        cur.maxDiscount = disc;
        cur.url = c.url ?? cur.url;
      }
    }
  }
  console.log(`Arbitrage cron: ${byDomain.size} distinct domains in feed`);

  const providerSlug = "arbitragecard";
  await sql`
    insert into providers (name, slug) values ('ArbitrageCard', ${providerSlug})
    on conflict (slug) do nothing
  `;
  const providerRow = await sql`select id from providers where slug = ${providerSlug} limit 1`;
  if (!providerRow.length) throw new Error("provider row missing");
  const providerId = providerRow[0].id as string;

  const brands = (await sql`
    select id, lower(base_domain) as domain from brands
    where base_domain is not null and base_domain <> ''
  `) as unknown as { id: string; domain: string }[];

  const brandsByDomain = new Map<string, string[]>();
  for (const b of brands) {
    const list = brandsByDomain.get(b.domain) ?? [];
    list.push(b.id);
    brandsByDomain.set(b.domain, list);
  }

  const nowTs = new Date().toISOString();
  let matched = 0;
  let unmatched = 0;
  let products = 0;
  let pending = 0;
  const seen = new Set<string>();

  for (const [domain, agg] of byDomain) {
    let brandIds = brandsByDomain.get(domain);
    if (!brandIds?.length) {
      // Match the other provider crons: surface an unknown brand as a pending
      // candidate rather than dropping it, so it shows up in the admin
      // pending-brands view where it can be approved or merged into an
      // existing brand (these are often domain variants of a brand we already
      // carry, e.g. shop.crackerbarrel.com vs crackerbarrel.com).
      const name = agg.name || domain;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug) { unmatched += 1; continue; }
      const ins = await sql`
        insert into brands (name, slug, base_domain, status)
        values (${name}, ${slug}, ${domain}, 'pending')
        on conflict (slug) do update set updated_at = now()
        returning id, status
      `;
      brandIds = [ins[0].id as string];
      if (ins[0].status === "pending") pending += 1;
      unmatched += 1;
      console.log(`Arbitrage cron: new brand candidate "${name}" (${domain}) -> pending`);
    }
    const inStock = agg.qty > 0;
    for (const brandId of brandIds) {
      seen.add(brandId);
      await sql`
        insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
        values (${providerId}, ${brandId}, ${agg.maxDiscount}, ${inStock}, ${nowTs})
        on conflict (provider_id, brand_id) do update set
          max_discount_percent = excluded.max_discount_percent,
          in_stock = excluded.in_stock,
          fetched_at = excluded.fetched_at
      `;
      // The brand-detail API filters out any offer without a product_url
      // (src/index.ts clickableOffers), so a discount row alone is invisible on
      // the site. Previously this was an UPDATE, which silently did nothing for
      // the ~95 brands that had no ArbitrageCard product row yet.
      //
      // Match on (provider, brand, variant) rather than the unique index, which
      // includes product_external_id: the stored external ids are stale from
      // before ArbitrageCard moved to WooCommerce (Callaway is 523 here but
      // 16693 in their API today), so keying on them would create duplicates.
      if (agg.url) {
        const tracked = withUtm(agg.url, domain);
        const existing = await sql`
          select id from provider_brand_products
          where provider_id = ${providerId} and brand_id = ${brandId} and variant = 'online'
          limit 1
        `;
        if (existing.length) {
          await sql`
            update provider_brand_products
            set product_url = ${tracked}, is_active = ${inStock},
                last_seen_at = ${nowTs}, discount_percent = null
            where id = ${existing[0].id}
          `;
        } else {
          await sql`
            insert into provider_brand_products
              (provider_id, brand_id, variant, product_external_id, product_url,
               is_active, first_seen_at, last_seen_at)
            values (${providerId}, ${brandId}, 'online', ${String(agg.merchantId ?? "")},
                    ${tracked}, ${inStock}, ${nowTs}, ${nowTs})
            on conflict (provider_id, brand_id, variant, coalesce(product_external_id, ''))
            do update set product_url = excluded.product_url,
                          is_active = excluded.is_active,
                          last_seen_at = excluded.last_seen_at
          `;
          products += 1;
        }
      }
      matched += 1;
    }
  }

  // Anything we previously had but the feed no longer lists is out of stock.
  const stale = await sql`
    update provider_brand_discounts
    set in_stock = false, fetched_at = ${nowTs}
    where provider_id = ${providerId}
      and fetched_at < ${nowTs}
      and in_stock = true
    returning brand_id
  `;

  // Record history only when the observation actually changed, matching the
  // other crons so the history table does not grow by a row per run per brand.
  await sql`
    insert into provider_brand_discount_history (provider_id, brand_id, max_discount_percent, in_stock, observed_at)
    select pbd.provider_id, pbd.brand_id, pbd.max_discount_percent, pbd.in_stock, pbd.fetched_at
    from provider_brand_discounts pbd
    left join lateral (
      select max_discount_percent, in_stock
      from provider_brand_discount_history h
      where h.provider_id = pbd.provider_id and h.brand_id = pbd.brand_id
      order by h.observed_at desc
      limit 1
    ) prev on true
    where pbd.provider_id = ${providerId}
      and pbd.fetched_at = ${nowTs}
      and (
        prev.max_discount_percent is distinct from pbd.max_discount_percent
        or prev.in_stock is distinct from pbd.in_stock
      )
  `;

  console.log(
    `Arbitrage cron: updated ${matched} brand rows across ${byDomain.size - unmatched} matched domains; ` +
      `${unmatched} unmatched (${pending} new pending brands); ${products} product rows created; ${stale.length} marked out of stock.`
  );

  await sql.end();
}

main().catch((err) => {
  console.error("Arbitrage cron: fatal", err);
  process.exit(1);
});
