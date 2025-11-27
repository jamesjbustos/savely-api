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
  return input.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, p1, p2) => `${p1}${p2.toUpperCase()}`);
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
  name = name.replace(/^(\d+)[\s-]+(\d+)\b[\s-]*/i, (m, g1, g2) => `${g1}-${g2}-`);
  name = name.replace(/^(\d+-\d+)-$/, "$1");
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    name = toTitleCase(name);
  }
  name = name.replace(/\s*-\s*/g, "-").replace(/-+/g, "-").replace(/\s+/g, " ").trim();
  name = name.replace(/^-+|-+$/g, "");
  return name;
}

// Looser cross-provider key for matching CardBear names to GCX slugs
function normalizeMatchKey(input) {
  if (!input) return "";
  return String(input)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, ""); // strip spaces, punctuation, hyphens
}

async function main() {
  loadDevVarsIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (set in .dev.vars or env).");
    process.exit(1);
  }
  const sql = neon(databaseUrl);

  // Load brands and aliases from DB for matching
  const dbBrands = await sql/* sql */ `
    select id, name, slug from brands
  `;
  const dbAliases = await sql/* sql */ `
    select brand_id, alias from brand_aliases
  `;

  const canonMap = new Map(); // normName -> array of { id, name, slug, source }

  for (const b of dbBrands) {
    const norm = normalizeBrandName(b.name);
    if (!norm) continue;
    if (!canonMap.has(norm)) canonMap.set(norm, []);
    canonMap.get(norm).push({ id: b.id, name: b.name, slug: b.slug, source: "brand" });
  }

  for (const a of dbAliases) {
    const norm = normalizeBrandName(a.alias);
    if (!norm) continue;
    if (!canonMap.has(norm)) canonMap.set(norm, []);
    canonMap.get(norm).push({ id: a.brand_id, name: a.alias, slug: null, source: "alias" });
  }

  // Fetch CardBear discounts
  const res = await fetch("https://www.cardbear.com/api/json.php", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
  });
  if (!res.ok) {
    console.error(`Failed to fetch CardBear API: ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  const discounts = Array.isArray(data?.discounts) ? data.discounts : [];

  // Prepare tasks for ALL CardBear brands (we'll mark whether they exist in DB)
  const tasks = []; // { cardbearId, storeName, url, inDb }

  for (const d of discounts) {
    const storeName = String(d.storeName ?? "").trim();
    if (!storeName) continue;
    const norm = normalizeBrandName(storeName);
    if (!norm) continue;
    const matches = canonMap.get(norm) || [];

    tasks.push({
      cardbearId: String(d.id ?? "").trim(),
      storeName,
      url: String(d.url ?? "").trim(),
      inDb: matches.length > 0,
    });
  }

  console.log(
    `CardBear: ${discounts.length} total brands, ${tasks.length} brands to scan for GCX/Arbitrage support.`
  );

  // For each CardBear brand, fetch its page and detect GCX / Arbitrage providers
  const results = [];
  let processed = 0;
  for (const t of tasks) {
    if (!t.url) continue;
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

      const supportsGCX =
        $('a[href*="giftstore=gcx"]').length > 0 ||
        $('img[alt*="GCX"]').length > 0;
      const supportsArbitrage =
        $('a[href*="giftstore=arbitrage"]').length > 0 ||
        $('img[alt*="Arbitrage"]').length > 0;

      if (supportsGCX || supportsArbitrage) {
        results.push({
          storeName: t.storeName,
          cardbearId: t.cardbearId,
          supportsGCX,
          supportsArbitrage,
          inDb: t.inDb,
        });
      }
    } catch (err) {
      console.warn(`Error fetching/parsing ${t.url}:`, err?.message || err);
    }

    processed += 1;
    if (processed % 50 === 0) {
      console.log(`Scanned ${processed}/${tasks.length} CardBear pages...`);
    }
    // Gentle delay to avoid hammering CardBear
    await new Promise((r) => setTimeout(r, 400));
  }

  // Fetch GCX sitemap and build slug → URL map
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
    const gcxMap = new Map(); // matchKey -> gcxUrl

    $gcx("url > loc").each((_, el) => {
      const loc = $gcx(el).text().trim();
      const m = loc.match(/\/buy-([^/?#]+?)-gift-cards/i);
      if (!m) return;
      const segment = m[1]; // e.g. "gamestop"
      const key = normalizeMatchKey(segment);
      if (!key) return;
      if (!gcxMap.has(key)) gcxMap.set(key, loc);
    });

    // Attach GCX URLs to results where we have a confident slug match
    let attached = 0;
    for (const r of results) {
      const key = normalizeMatchKey(r.storeName);
      const gcxUrl = gcxMap.get(key);
      if (gcxUrl) {
        r.gcxUrl = gcxUrl;
        attached += 1;
      }
    }
    console.log(
      `Matched ${attached} CardBear GCX/Arbitrage brands to GCX product URLs by slug.`
    );
  }

  const report = {
    totalCardBearBrands: discounts.length,
    totalDbMatchedBrands: tasks.filter((t) => t.inDb).length,
    totalWithGCXOrArbitrage: results.length,
    totalWithGCXOrArbitrageInDb: results.filter((r) => r.inDb).length,
    brands: results,
  };

  const outPath = resolve(
    process.cwd(),
    "temp",
    "data",
    "cardbear_gcx_arbitrage_supported.json"
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`Wrote CardBear GCX/Arbitrage support report to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


