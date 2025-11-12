import { canonicalizeBrandName, toSlug } from "./util";

function variantsForAliases(name: string): string[] {
  const base = name.trim();
  const noDotCom = base.replace(/\.\s*com$/i, "");
  const andSwapA = base.replace(/&/g, " and ");
  const andSwapB = base.replace(/\band\b/gi, "&");
  const compactHyphens = base.replace(/\s*-\s*/g, "-");
  const collapsedSpaces = base.replace(/\s+/g, " ");
  // Deduplicate while preserving order
  const set = new Set<string>(
    [base, noDotCom, andSwapA, andSwapB, compactHyphens, collapsedSpaces]
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return [...set];
}

export async function upsertBrand(sql: any, rawName: string) {
  const canonicalName = canonicalizeBrandName(rawName);
  const slug = toSlug(canonicalName);

  // 1) Try exact slug match first
  const bySlug = await sql/* sql */ `
    SELECT id FROM brands WHERE slug = ${slug} LIMIT 1
  `;
  if (bySlug.length) {
    const id = bySlug[0].id as string;
    // Backfill aliases for any new variant we just saw
    for (const alias of variantsForAliases(rawName)) {
      await sql/* sql */ `
        INSERT INTO brand_aliases (brand_id, alias)
        VALUES (${id}, ${alias})
        ON CONFLICT DO NOTHING
      `;
    }
    return id;
  }

  // 2) Otherwise, see if any alias already points to an existing brand
  const aliases = variantsForAliases(rawName);
  const lowerAliases = aliases.map((a) => a.toLowerCase());
  const byAlias = await sql/* sql */ `
    SELECT ba.brand_id AS id
    FROM brand_aliases ba
    WHERE lower(ba.alias) = ANY (${lowerAliases})
    LIMIT 1
  `;
  if (byAlias.length) {
    const id = byAlias[0].id as string;
    for (const alias of aliases.concat([canonicalName])) {
      await sql/* sql */ `
        INSERT INTO brand_aliases (brand_id, alias)
        VALUES (${id}, ${alias})
        ON CONFLICT DO NOTHING
      `;
    }
    return id;
  }

  // 3) New brand: insert and record aliases
  const ins = await sql/* sql */ `
    INSERT INTO brands (name, slug, status)
    VALUES (${canonicalName}, ${slug}, 'active')
    RETURNING id
  `;
  const id = ins[0].id as string;
  for (const alias of aliases.concat([canonicalName])) {
    await sql/* sql */ `
      INSERT INTO brand_aliases (brand_id, alias)
      VALUES (${id}, ${alias})
      ON CONFLICT DO NOTHING
    `;
  }
  return id;
}
