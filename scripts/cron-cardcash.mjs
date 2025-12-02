import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { neon } from "@neondatabase/serverless";

function loadDevVarsIfPresent() {
  const devVarsPath = resolve(process.cwd(), ".dev.vars");
  try {
    const raw = readFileSync(devVarsPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // ignore
  }
}

function toTitleCase(input) {
  return input
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (m, p1, p2) => `${p1}${p2.toUpperCase()}`);
}

function normalizeBrandName(rawName) {
  if (!rawName || typeof rawName !== "string") return "";
  let name = rawName.normalize("NFKC").trim();
  name = name.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[®™]/g, "");
  {
    const rawLower = rawName.toLowerCase();
    if (/\bxbox\s+prepaid\b/.test(rawLower)) return "Xbox";
    if (/\bxbox\s+game\s+pass\b/.test(rawLower)) return "Xbox Game Pass";
  }
  name = name.replace(/\bpowered\s+by\s+.+$/i, " ").trim();
  name = name.replace(/\([^)]*\)/g, " ").trim();
  name = name.replace(/\.com\b/gi, " ").trim();
  const noisePatterns = [
    /\b(in[\s-]?store\s+only)\b/gi,
    /\bonline\s+only\b/gi,
    /\b(app\s+only)\b/gi,
    /\b(merchandise\s+credit)\b/gi,
    /\b(e[\s-]?gift(?:\s+card)?)\b/gi,
    /\b(physical\s+cards?)\b/gi,
    /\bgift\s*cards?\b/gi,
    /\binstant\s+delivery\b/gi,
  ];
  for (const pat of noisePatterns) name = name.replace(pat, " ");
  name = name.replace(/\s+/g, " ").trim();
  name = name.replace(
    /^(\d+)[\s-]+(\d+)\b[\s-]*/i,
    (m, g1, g2) => `${g1}-${g2}-`
  );
  name = name.replace(/^(\d+-\d+)-$/, "$1");
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (
    letters &&
    (letters === letters.toUpperCase() || letters === letters.toLowerCase())
  ) {
    name = toTitleCase(name);
  }
  name = name
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  name = name.replace(/^-+|-+$/g, "");
  return name;
}

function slugifyBrandName(name) {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

function mapCardTypeToVariant(cardType, name) {
  const t = String(cardType ?? "").toLowerCase();
  const n = String(name ?? "").toLowerCase();
  if (
    t.includes("ecode") ||
    t.includes("e-code") ||
    t.includes("digital") ||
    t.includes("online")
  )
    return "online";
  if (t.includes("in-store") || t.includes("instore") || t.includes("store"))
    return "in_store";

  if (/\bin[\s-]?store\b/.test(n) || /\bphysical\b/.test(n)) return "in_store";
  if (
    /\bonline\s+only\b/.test(n) ||
    /\be[\s-]?gift\b/.test(n) ||
    /\bapp\s+only\b/.test(n)
  )
    return "online";

  return "other";
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const HOMEPAGE_URL = "https://www.cardcash.com/";
const API_URL =
  "https://production-api.cardcash.com/v3/merchants/buy?cache=bust";
const COOKIE_NAME = "q3vsT1zXO";

function buildCardCashProductUrl(slug) {
  const cleanedSlug = String(slug ?? "").replace(/^\/+/, "");

  // Raw (non-affiliate) CardCash URL
  const rawUrl = cleanedSlug
    ? `https://www.cardcash.com/buy-gift-cards/${cleanedSlug}`
    : "https://www.cardcash.com/buy-gift-cards/";

  // Read affiliate config at call time so values set by loadDevVarsIfPresent()
  // are visible even though it runs later in main().
  const siteId = process.env.LINKSYNERGY_SITE_ID || "";
  const advertiserId = process.env.CARDCASH_ADVERTISER_ID || "45394";

  // If affiliate env is not configured, fall back to raw URL
  if (!siteId) {
    return rawUrl;
  }

  // Build LinkSynergy deep link without needing to hit their API:
  // https://click.linksynergy.com/deeplink?id=<siteId>&mid=<advertiserId>&murl=<encodedRawUrl>
  const encodedRaw = encodeURIComponent(rawUrl);
  return `https://click.linksynergy.com/deeplink?id=${encodeURIComponent(
    siteId
  )}&mid=${encodeURIComponent(advertiserId)}&murl=${encodedRaw}`;
}

async function fetchCardCashMerchants() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "en-US",
      extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
    });
    const page = await context.newPage();

    // 1) Prefer hitting the homepage; it also triggers the API/cookie flow
    try {
      await page.goto(HOMEPAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    } catch (e) {
      console.warn(
        "CardCash homepage navigation did not fully settle, continuing:",
        e?.name || e
      );
    }

    // 2) Best-effort: wait briefly for the homepage to call the merchants API itself
    try {
      await page.waitForResponse(
        (res) =>
          res.url().includes("/v3/merchants/buy") &&
          res.url().startsWith("https://production-api.cardcash.com"),
        { timeout: 4000 }
      );
    } catch {
      // Ignore timeout; we'll try a direct fetch next
    }

    // 3) Try to get the cookie from the API domain
    let apiCookies = await context.cookies(
      "https://production-api.cardcash.com"
    );
    let sess = apiCookies.find((c) => c.name === COOKIE_NAME);

    // 4) If cookie isn't set yet, try calling the API once without auth to let it Set-Cookie
    if (!sess) {
      try {
        await page.request.fetch(API_URL, {
          headers: {
            accept: "application/json, text/plain, */*",
            origin: "https://www.cardcash.com",
            referer: "https://www.cardcash.com/",
          },
        });
      } catch {
        // Ignore and allow fallback below
      }
      apiCookies = await context.cookies("https://production-api.cardcash.com");
      sess = apiCookies.find((c) => c.name === COOKIE_NAME);
    }

    if (!sess) {
      throw new Error(
        `${COOKIE_NAME} cookie not found on production-api.cardcash.com`
      );
    }

    // 5) Call the API with the cookie + required headers
    const res = await page.request.fetch(API_URL, {
      headers: {
        accept: "application/json, text/plain, */*",
        Cookie: `${COOKIE_NAME}=${sess.value}`,
        "x-cc-app": COOKIE_NAME,
        origin: "https://www.cardcash.com",
        referer: "https://www.cardcash.com/",
      },
    });

    if (!res.ok()) {
      const body = await res.text();
      throw new Error(
        `CardCash API status ${res.status()}: ${body.slice(0, 500)}`
      );
    }

    const json = await res.json();
    const merchants = Array.isArray(json?.buyMerchants)
      ? json.buyMerchants
      : [];
    return merchants;
  } finally {
    await browser.close();
  }
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (set in .dev.vars or env).");
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  const providerSlug = "cardcash";
  const providerName = "CardCash";

  // Ensure provider exists
  await sql/* sql */ `
    insert into providers (name, slug)
    values (${providerName}, ${providerSlug})
    on conflict (slug) do nothing
  `;
  const providerRow = await sql/* sql */ `
    select id from providers where slug = ${providerSlug} limit 1
  `;
  if (!providerRow?.[0]?.id) {
    console.error("Failed to resolve provider id for CardCash");
    process.exit(1);
  }
  const providerId = providerRow[0].id;

  console.log("Fetching CardCash merchants via Playwright...");
  const merchants = await fetchCardCashMerchants();
  console.log(`CardCash cron: fetched ${merchants.length} merchants from API`);

  const nowTs = new Date().toISOString();
  const brandDiscounts = new Map();

  // Existing CardCash products keyed by external id (merchant id from API)
  const existingProducts = await sql/* sql */ `
    select brand_id, coalesce(product_external_id, '') as external_id
    from provider_brand_products
    where provider_id = ${providerId}
  `;

  const byExternalId = new Map();
  for (const row of existingProducts) {
    const externalId = String(row.external_id ?? "").trim();
    if (!externalId) continue;
    byExternalId.set(externalId, row.brand_id);
  }

  // 1) Pessimistically mark everything as out of stock / inactive
  await sql/* sql */ `
    update provider_brand_discounts
    set in_stock = false,
        fetched_at = ${nowTs}
    where provider_id = ${providerId}
  `;

  await sql/* sql */ `
    update provider_brand_products
    set is_active = false,
        last_checked_at = ${nowTs}
    where provider_id = ${providerId}
  `;

  let updated = 0;
  let newBrands = 0;

  for (const m of merchants) {
    const externalId = String(m.id ?? "").trim();
    const providerBrandName = String(m.name ?? "").trim();
    if (!externalId || !providerBrandName) continue;

    const cardsAvailable = Number(m.cardsAvailable ?? 0) || 0;
    const ecodesAvailable = Number(m.ecodesAvailable ?? 0) || 0;
    const inStock = cardsAvailable + ecodesAvailable > 0;
    const maxDiscountPercent = Math.max(0, Number(m.upToPercentage ?? 0)) || 0;

    // Prefer existing brand strictly by external id; only create a new
    // pending brand when we see an id we've never stored before.
    let brandId = byExternalId.get(externalId);

    if (!brandId) {
      const normalizedName = normalizeBrandName(providerBrandName);
      if (!normalizedName) continue;
      const brandSlug = slugifyBrandName(normalizedName);

      const ins = await sql/* sql */ `
        insert into brands (name, slug, status)
        values (${normalizedName}, ${brandSlug}, 'pending')
        on conflict (slug)
        do update set name = excluded.name, updated_at = now()
        returning id
      `;
      brandId = ins[0].id;
      newBrands += 1;
      console.log(
        `CardCash cron: detected new brand candidate "${normalizedName}" (slug=${brandSlug})`
      );

      // Alias original provider name if it differs from our normalized name
      if (
        providerBrandName &&
        providerBrandName.toLowerCase() !== normalizedName.toLowerCase()
      ) {
        await sql/* sql */ `
          insert into brand_aliases (brand_id, alias)
          values (${brandId}, ${providerBrandName})
          on conflict do nothing
        `;
      }
    }

    const prev = brandDiscounts.get(brandId) || {
      maxDiscount: 0,
      inStock: false,
    };
    brandDiscounts.set(brandId, {
      maxDiscount: Math.max(prev.maxDiscount, maxDiscountPercent),
      inStock: prev.inStock || inStock,
    });

    // Variant and URL
    const variant = mapCardTypeToVariant(m.cardType ?? null, providerBrandName);
    const slug = String(m.slug ?? "").replace(/^\/+/, "");
    const productUrl = buildCardCashProductUrl(slug);

    await sql/* sql */ `
      insert into provider_brand_products
        (provider_id, brand_id, variant, product_external_id, product_url, discount_percent, is_active, last_seen_at, last_checked_at)
      values
        (${providerId}, ${brandId}, ${variant}, ${externalId}, ${productUrl}, ${maxDiscountPercent}, ${inStock}, ${nowTs}, ${nowTs})
      on conflict do nothing
    `;
    await sql/* sql */ `
      update provider_brand_products
      set
        is_active = ${inStock},
        last_seen_at = ${nowTs},
        last_checked_at = ${nowTs},
        product_url = ${productUrl},
        discount_percent = ${maxDiscountPercent}
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and variant = ${variant}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
    `;
    await sql/* sql */ `
      delete from provider_brand_products
      where provider_id = ${providerId}
        and brand_id = ${brandId}
        and coalesce(product_external_id, '' ) = coalesce(${externalId}, '' )
        and variant <> ${variant}
    `;

    updated += 1;
  }

  for (const [brandId, agg] of brandDiscounts.entries()) {
    await sql/* sql */ `
      insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
      values (${providerId}, ${brandId}, ${agg.maxDiscount}, ${agg.inStock}, ${nowTs})
      on conflict (provider_id, brand_id)
      do update set
        max_discount_percent = excluded.max_discount_percent,
        in_stock = excluded.in_stock,
        fetched_at = excluded.fetched_at
    `;
  }

  // 3) Append a snapshot of the current state into history
  await sql/* sql */ `
    insert into provider_brand_discount_history (
      provider_id,
      brand_id,
      max_discount_percent,
      in_stock,
      observed_at
    )
    select
      pbd.provider_id,
      pbd.brand_id,
      pbd.max_discount_percent,
      pbd.in_stock,
      pbd.fetched_at
    from provider_brand_discounts pbd
    left join lateral (
      select
        max_discount_percent,
        in_stock
      from provider_brand_discount_history h
      where h.provider_id = pbd.provider_id
        and h.brand_id = pbd.brand_id
      order by observed_at desc
      limit 1
    ) last on true
    where pbd.provider_id = ${providerId}
      and (
        last.max_discount_percent is null
        or last.max_discount_percent is distinct from pbd.max_discount_percent
        or last.in_stock is distinct from pbd.in_stock
      )
  `;

  console.log(
    `CardCash cron: updated ${updated} merchants; ` +
      `${newBrands} new brand candidates marked as pending; ` +
      "all others remain marked out of stock / inactive."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
