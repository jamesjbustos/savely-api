```txt
npm install
npm run dev
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

## Offer inventory snapshots

To record total live offers over time (per provider), a cron helper writes into the `offer_inventory_snapshots` table:

- Run `npm run cron:offer-inventory` (with `DATABASE_URL` set) to insert an hourly snapshot of live offers per active provider, based on `v_brand_provider_offers` and `in_stock = true`.
- Query totals over time, for example:
  - Global total at each snapshot: `select snapshot_at, sum(live_offer_count) as total from offer_inventory_snapshots group by snapshot_at order by snapshot_at;`
  - Per-provider trends: `select snapshot_at, provider_id, live_offer_count from offer_inventory_snapshots where provider_id = '<provider-id>' order by snapshot_at;`
