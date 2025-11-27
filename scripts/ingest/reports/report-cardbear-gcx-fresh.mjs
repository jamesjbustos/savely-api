import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import { load as loadHtml } from "cheerio";

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

function normalizeMatchKey(input) {
  if (!input) return "";
  return String(input)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (set in .dev.vars or env).");
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  // Load brands + aliases for inDb flag
  const dbBrands = await sql/* sql */ `
    select id, name, slug from brands
  `;
  const dbAliases = await sql/* sql */ `
    select brand_id, alias from brand_aliases
  `;

  const canonMap = new Map(); // normName -> true
  for (const b of dbBrands) {
    const norm = normalizeBrandName(b.name);
    if (!norm) continue;
    canonMap.set(norm, true);
  }
  for (const a of dbAliases) {
    const norm = normalizeBrandName(a.alias);
    if (!norm) continue;
    canonMap.set(norm, true);
  }

  // Fetch CardBear discounts (master list)
  const res = await fetch("https://www.cardbear.com/api/json.php", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
  });
  if (!res.ok) {
    console.error(`Failed to fetch CardBear API: ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  const discounts = Array.isArray(data?.discounts) ? data.discounts : [];

  // Optional test limit to avoid hitting the full set on trial runs
  const testLimitEnv = process.env.CARDBEAR_GCX_TEST_LIMIT;
  const testLimit = testLimitEnv ? parseInt(testLimitEnv, 10) : null;

  let tasks = discounts
    .map((d) => ({
      cardbearId: String(d.id ?? "").trim(),
      storeName: String(d.storeName ?? "").trim(),
      url: String(d.url ?? "").trim(),
    }))
    .filter((t) => t.cardbearId && t.storeName && t.url);

  if (testLimit && Number.isFinite(testLimit) && testLimit > 0) {
    tasks = tasks.slice(0, testLimit);
  }

  console.log(
    `CardBear: ${discounts.length} total brands, ${tasks.length} with usable URLs (scraping pages for GCX/Arbitrage).`
  );

  const brands = [];
  let processed = 0;
  const delayMs = Number(process.env.CARDBEAR_GCX_DELAY_MS || "") || 400;

  for (const t of tasks) {
    try {
      const pageRes = await fetch(t.url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
      });
      if (!pageRes.ok) {
        console.warn(`Failed to fetch ${t.url}: ${pageRes.status}`);
        continue;
      }
      const html = await pageRes.text();
      const $ = loadHtml(html);

      const supportsArbitrage =
        $('a[href*="giftstore=arbitrage"]').length > 0 ||
        $('img[alt*="Arbitrage"]').length > 0;

      const supportsGCX =
        $('a[href*="giftstore=raise"]').length > 0 ||
        $('a[href*="giftstore=raisecashback"]').length > 0 ||
        $('img[alt*="Raise"]').length > 0;

      if (supportsArbitrage || supportsGCX) {
        const norm = normalizeBrandName(t.storeName);
        const inDb = !!canonMap.get(norm);
        brands.push({
          storeName: t.storeName,
          cardbearId: t.cardbearId,
          supportsGCX,
          supportsArbitrage,
          inDb,
        });
      }
    } catch (err) {
      console.warn(`Error fetching/parsing ${t.url}:`, err?.message || err);
    }

    processed += 1;
    if (processed % 50 === 0) {
      console.log(`Scanned ${processed}/${tasks.length} CardBear pages...`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // Attach GCX URLs via GCX sitemap
  try {
    const gcxRes = await fetch(
      "https://gcx.raise.com/sitemap/product_sources.xml",
      {
        headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
      }
    );
    if (!gcxRes.ok) {
      console.error(
        `Failed to fetch GCX product_sources sitemap: ${gcxRes.status}`
      );
    } else {
      const xml = await gcxRes.text();
      const $gcx = loadHtml(xml, { xmlMode: true });
      const gcxMap = new Map(); // matchKey -> url

      $gcx("url > loc").each((_, el) => {
        const loc = $gcx(el).text().trim();
        const m = loc.match(/\/buy-([^/?#]+?)-gift-cards/i);
        if (!m) return;
        const segment = m[1];
        const key = normalizeMatchKey(segment);
        if (!key) return;
        if (!gcxMap.has(key)) gcxMap.set(key, loc);
      });

      let attached = 0;
      for (const b of brands) {
        if (!b.supportsGCX) continue; // only attach GCX URL where GCX is actually present on CardBear
        const key = normalizeMatchKey(b.storeName);
        const url = gcxMap.get(key);
        if (url) {
          b.gcxUrl = url;
          attached += 1;
        }
      }
      console.log(`Attached GCX URLs for ${attached} brands.`);
    }
  } catch (err) {
    console.error("Error attaching GCX URLs:", err?.message || err);
  }

  const report = {
    totalCardBearBrands: discounts.length,
    totalWithGCXOrArbitrage: brands.length,
    totalWithGCXOrArbitrageInDb: brands.filter((b) => b.inDb).length,
    brands,
  };

  const outPath = resolve(
    process.cwd(),
    "temp",
    "data",
    "cardbear_gcx_arbitrage_supported_v2.json"
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`Wrote fresh GCX/Arbitrage report to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
