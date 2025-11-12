import { neon } from "@neondatabase/serverless";

export function getDb(env: { DATABASE_URL: string }) {
  return neon(env.DATABASE_URL);
}

export async function ensureBrandAliasIndexes(sql: any) {
  // a) Make (brand_id, alias) unique so ON CONFLICT works
  await sql/* sql */ `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_alias_per_brand
    ON brand_aliases (brand_id, lower(alias));
  `;
  // b) Optional but recommended: prevent the same alias pointing to two brands
  try {
    await sql/* sql */ `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_alias_global
      ON brand_aliases (lower(alias));
    `;
  } catch {
    // If duplicates currently exist, skip creating the global uniqueness index.
    // You can clean collisions and re-run this later.
  }
}
