import { getDb } from "../db";

export async function seedProviders(env: { DATABASE_URL: string }) {
  const sql = getDb(env);
  const providers = [
    { name: "CardCash", slug: "cardcash" },
    { name: "GCX", slug: "gcx" }, // Raise’s GCX
  ];
  for (const p of providers) {
    await sql/* sql */ `
      insert into providers (name, slug)
      values (${p.name}, ${p.slug})
      on conflict (name) do nothing
    `;
  }
}
