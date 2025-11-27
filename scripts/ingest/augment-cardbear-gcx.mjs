import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadHtml } from "cheerio";

function normalizeMatchKey(input) {
  if (!input) return "";
  return String(input)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

async function main() {
  const inputPath = resolve(
    process.cwd(),
    "temp",
    "data",
    "cardbear_gcx_arbitrage_supported.json"
  );
  const raw = readFileSync(inputPath, "utf8");
  const json = JSON.parse(raw);

  const brands = Array.isArray(json?.brands) ? json.brands : [];
  if (!brands.length) {
    console.error(
      "No brands found in cardbear_gcx_arbitrage_supported.json; run the CardBear report first."
    );
    process.exit(1);
  }

  // Index existing brands by CardBear id for easy updates / inserts
  const byId = new Map();
  for (const b of brands) {
    if (!b.cardbearId) continue;
    byId.set(String(b.cardbearId), b);
  }

  // 1) Use CardBear API metadata to mark GCX support (raise/raisecashback)
  try {
    const resCb = await fetch("https://www.cardbear.com/api/json.php", {
      headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
    });
    if (!resCb.ok) {
      console.error(
        `Failed to fetch CardBear API for GCX metadata: ${resCb.status}`
      );
    } else {
      const data = await resCb.json();
      const discounts = Array.isArray(data?.discounts) ? data.discounts : [];
      let marked = 0;
      let inserted = 0;

      for (const d of discounts) {
        const id = String(d.id ?? "").trim();
        if (!id) continue;
        const reseller = String(d.highestDiscountReseller ?? "").toLowerCase();
        const isGCXReseller =
          reseller === "raise" || reseller === "raisecashback";
        if (!isGCXReseller) continue;

        let entry = byId.get(id);
        if (entry) {
          if (!entry.supportsGCX) {
            entry.supportsGCX = true;
            marked += 1;
          }
        } else {
          // Brand has GCX via CardBear but wasn't in the original HTML-based report
          entry = {
            storeName: String(d.storeName ?? "").trim() || null,
            cardbearId: id,
            supportsGCX: true,
            supportsArbitrage: false,
            inDb: false,
          };
          brands.push(entry);
          byId.set(id, entry);
          inserted += 1;
        }
      }

      console.log(
        `CardBear API GCX augmentation: marked supportsGCX=true for ${marked} existing brands, inserted ${inserted} new GCX-only brands.`
      );
    }
  } catch (err) {
    console.error(
      "Error augmenting GCX support from CardBear API:",
      err?.message || err
    );
  }

  // 2) Fetch GCX sitemap and build slug → URL map (no individual GCX product calls)
  const res = await fetch(
    "https://gcx.raise.com/sitemap/product_sources.xml",
    {
      headers: { "user-agent": "Mozilla/5.0 (compatible; SavelyBot/1.0)" },
    }
  );
  if (!res.ok) {
    console.error(
      `Failed to fetch GCX product_sources sitemap: ${res.status}`
    );
    process.exit(1);
  }
  const xml = await res.text();
  const $ = loadHtml(xml, { xmlMode: true });

  const gcxMap = new Map(); // matchKey -> gcxUrl
  $("url > loc").each((_, el) => {
    const loc = $(el).text().trim();
    const m = loc.match(/\/buy-([^/?#]+?)-gift-cards/i);
    if (!m) return;
    const segment = m[1]; // e.g., "gamestop"
    const key = normalizeMatchKey(segment);
    if (!key) return;
    if (!gcxMap.has(key)) gcxMap.set(key, loc);
  });

  let attached = 0;
  for (const b of brands) {
    const key = normalizeMatchKey(b.storeName);
    const gcxUrl = gcxMap.get(key);
    if (gcxUrl) {
      if (!b.gcxUrl) attached += 1;
      b.gcxUrl = gcxUrl;
    }
  }

  console.log(
    `Attached GCX URLs for ${attached} brands (by loose slug/name match).`
  );

  const outPath = resolve(
    process.cwd(),
    "temp",
    "data",
    "cardbear_gcx_arbitrage_supported.json"
  );
  writeFileSync(outPath, JSON.stringify(json, null, 2), "utf8");
  console.log(`Updated ${outPath} with GCX support and gcxUrl where matched.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


