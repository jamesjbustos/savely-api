import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

function loadDevVarsIfPresent() {
  const devVarsPath = resolve(process.cwd(), ".dev.vars");
  try {
    const raw = readFileSync(devVarsPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore if missing
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

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is required. Provide it in environment or .dev.vars"
    );
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  // Ensure GCX and Arbitrage providers exist
  const providersToEnsure = [
    { slug: "gcx", name: "GCX" },
    { slug: "arbitragecard", name: "ArbitrageCard" },
  ];

  for (const p of providersToEnsure) {
    await sql/* sql */ `
      insert into providers (name, slug)
      values (${p.name}, ${p.slug})
      on conflict (slug) do nothing
    `;
  }

  const providerRows = await sql/* sql */ `
    select id, slug from providers where slug in ('gcx', 'arbitragecard')
  `;
  const gcxProvider = providerRows.find((p) => p.slug === "gcx");
  const arbProvider = providerRows.find((p) => p.slug === "arbitragecard");
  if (!gcxProvider || !arbProvider) {
    console.error("Failed to resolve provider ids for GCX and ArbitrageCard");
    process.exit(1);
  }
  const gcxProviderId = gcxProvider.id;
  const arbProviderId = arbProvider.id;

  // Load seed JSON
  const jsonPath = resolve(process.cwd(), "data", "cardbear_final.json");
  const raw = readFileSync(jsonPath, "utf8");
  const data = JSON.parse(raw);
  const brands = Array.isArray(data?.brands) ? data.brands : [];

  const nowTs = new Date().toISOString();
  let linkedGcx = 0;
  let linkedArb = 0;
  let skippedNoBrand = 0;
  const skippedDetails = [];
  const createdBrandDetails = [];

  for (const b of brands) {
    const cardbearId = String(b.cardbearId ?? "").trim();
    const storeName = String(b.storeName ?? "").trim();
    if (!cardbearId || !storeName) continue;

    const supportsGCX = !!b.supportsGCX && !!b.gcxUrl;
    const supportsArb = !!b.supportsArbitrage && !!b.arbitrageUrl;
    if (!supportsGCX && !supportsArb) continue;

    const normalizedName = normalizeBrandName(storeName);
    if (!normalizedName) continue;

    // Find brand by canonical name or alias; if missing, create a new brand
    let brandId = null;
    const byName = await sql/* sql */ `
      select id from brands where lower(name) = lower(${normalizedName}) limit 1
    `;
    if (byName?.length) {
      brandId = byName[0].id;
    } else {
      const byAlias = await sql/* sql */ `
        select b.id
        from brand_aliases a
        join brands b on b.id = a.brand_id
        where lower(a.alias) = lower(${normalizedName})
        limit 1
      `;
      if (byAlias?.length) {
        brandId = byAlias[0].id;
      } else {
        // Create a new brand row for this CardBear entry
        const brandSlug = slugifyBrandName(normalizedName);
        const inserted = await sql/* sql */ `
          insert into brands (name, slug)
          values (${normalizedName}, ${brandSlug})
          on conflict (slug)
          do update set name = excluded.name, updated_at = now()
          returning id
        `;
        if (inserted?.length) {
          brandId = inserted[0].id;
          createdBrandDetails.push({
            cardbearId,
            storeName,
            normalizedName,
          });
        }
      }
    }

    if (!brandId) {
      // Should be rare (e.g. insert failed)
      skippedNoBrand += 1;
      skippedDetails.push({ cardbearId, storeName, supportsGCX, supportsArb });
      continue;
    }

    const variant = "online";

    if (supportsGCX) {
      const gcxUrl = String(b.gcxUrl ?? "").trim();
      if (gcxUrl) {
        // Seed/refresh discount row: 0% and out_of_stock by default, cron will update
        await sql/* sql */ `
          insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
          values (${gcxProviderId}, ${brandId}, ${0}, ${false}, ${nowTs})
          on conflict (provider_id, brand_id)
          do update set fetched_at = excluded.fetched_at
        `;

        // Seed provider_brand_products row keyed by CardBear id
        await sql/* sql */ `
          insert into provider_brand_products
            (provider_id, brand_id, variant, product_external_id, product_url, is_active, last_seen_at, last_checked_at, card_image_url)
          values
            (${gcxProviderId}, ${brandId}, ${variant}, ${cardbearId}, ${gcxUrl}, ${true}, ${nowTs}, ${nowTs}, ${null})
          on conflict do nothing
        `;
        await sql/* sql */ `
          update provider_brand_products
          set
            is_active = true,
            last_seen_at = ${nowTs},
            last_checked_at = ${nowTs},
            product_url = ${gcxUrl},
            card_image_url = null
          where provider_id = ${gcxProviderId}
            and brand_id = ${brandId}
            and variant = ${variant}
            and coalesce(product_external_id, '' ) = coalesce(${cardbearId}, '' )
        `;

        linkedGcx += 1;
      }
    }

    if (supportsArb) {
      const arbUrl = String(b.arbitrageUrl ?? "").trim();
      if (arbUrl) {
        await sql/* sql */ `
          insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
          values (${arbProviderId}, ${brandId}, ${0}, ${false}, ${nowTs})
          on conflict (provider_id, brand_id)
          do update set fetched_at = excluded.fetched_at
        `;

        await sql/* sql */ `
          insert into provider_brand_products
            (provider_id, brand_id, variant, product_external_id, product_url, is_active, last_seen_at, last_checked_at, card_image_url)
          values
            (${arbProviderId}, ${brandId}, ${variant}, ${cardbearId}, ${arbUrl}, ${true}, ${nowTs}, ${nowTs}, ${null})
          on conflict do nothing
        `;
        await sql/* sql */ `
          update provider_brand_products
          set
            is_active = true,
            last_seen_at = ${nowTs},
            last_checked_at = ${nowTs},
            product_url = ${arbUrl},
            card_image_url = null
          where provider_id = ${arbProviderId}
            and brand_id = ${brandId}
            and variant = ${variant}
            and coalesce(product_external_id, '' ) = coalesce(${cardbearId}, '' )
        `;

        linkedArb += 1;
      }
    }
  }

  console.log(
    `Seeded GCX links for ${linkedGcx} brands and ArbitrageCard links for ${linkedArb} brands. Skipped ${skippedNoBrand} brands with no matching DB brand.`
  );
  if (createdBrandDetails.length) {
    console.log("Created new brand rows for CardBear entries:");
    for (const c of createdBrandDetails) {
      console.log(
        `+ id=${c.cardbearId} name="${c.storeName}" normalized="${c.normalizedName}"`
      );
    }
  }
  if (skippedDetails.length) {
    console.log("Unmatched CardBear brands (no DB brand found):");
    for (const s of skippedDetails) {
      console.log(
        `- id=${s.cardbearId} name="${s.storeName}" gcx=${s.supportsGCX} arbitrage=${s.supportsArb}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


