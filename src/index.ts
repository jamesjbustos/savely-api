import { Hono } from "hono";
import { getDb } from "./db";
import { harvestCardCash } from "./ingest/cardcash";
import { harvestCardCenter } from "./ingest/cardcenter";
import { harvestCardDepot } from "./ingest/carddepot";
import { harvestGiftCardOutlets } from "./ingest/giftcardoutlets";
import { harvestArbitrageCard } from "./ingest/arbitragecard";
import { harvestGiftCardSaving } from "./ingest/giftcardsaving";
import { harvestCardCookie } from "./ingest/cardcookie";

type Env = {
  DATABASE_URL: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));

app.get("/brands", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql/* sql */ `
    select id, name, slug, status from brands order by name asc limit 50
  `;
  return c.json(rows);
});

app.post("/admin/ingest/cardcash", async (c) => {
  const result = await harvestCardCash(c.env);
  return c.json(result);
});

app.post("/admin/ingest/cardcenter", async (c) => {
  const result = await harvestCardCenter(c.env);
  return c.json(result);
});

app.post("/admin/ingest/carddepot", async (c) => {
  // <-- add
  const result = await harvestCardDepot(c.env);
  return c.json(result);
});

app.post("/admin/ingest/cardcookie", async (c) => {
  const result = await harvestCardCookie(c.env);
  return c.json(result);
});

app.post("/admin/ingest/giftcardoutlets", async (c) => {
  const result = await harvestGiftCardOutlets(c.env);
  return c.json(result);
});

app.post("/admin/ingest/arbitragecard", async (c) => {
  const result = await harvestArbitrageCard(c.env);
  return c.json(result);
});

app.post("/admin/ingest/giftcardsaving", async (c) => {
  const result = await harvestGiftCardSaving(c.env);
  return c.json(result);
});

export default app;
