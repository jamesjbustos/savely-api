# Analytics

How we track extension and website events without blowing up Supabase egress.

## Architecture

```
Extension                      Website (carddeals.co)
   ↓                              ↓
savely-api (CF Worker)       Next.js /api/track
   ↓                              ↓
   └──────────┬───────────────────┘
              ↓
   Axiom (savely_events dataset)
              ↑
   CF Cron every 15min → handleScheduled()
              ↓
     KV (popular-brands key)
              ↑
     /popular-brands + /analytics/popular-giftcards
```

Events from both sources land in the same dataset and are tagged with `source: "extension" | "website"`. The popular-brands cron aggregates across both.

All raw events go to **Axiom** (not Supabase). The 15-minute Worker cron queries Axiom, enriches with discount data from Supabase, and writes a pre-computed list to KV. Public endpoints read from KV in <1ms with zero DB egress.

## Why this setup

Previously every `/offers` call wrote a row to `brand_daily_viewers` in Supabase, and every extension event wrote to `extension_events`. `/popular-brands` then queried those tables with no cache. That architecture caused the Supabase egress to blow past the free tier.

The new setup:
- Event writes go to Axiom (500GB/mo free, 30-day retention) instead of Supabase
- Popular brands are computed once every 15 min and cached in KV
- `/popular-brands` responds from KV instead of running an aggregation query on every request

## Where things live

### Axiom
- Account: jamesjbustos@gmail.com
- Dataset: `savely_events` (30-day retention, US East 1). A rename to `carddeals_events` is still pending — when done, reissue `AXIOM_TOKEN` for the new dataset and update Worker env.
- Ingest endpoint: `https://api.axiom.co/v1/datasets/savely_events/ingest`
- Query endpoint: `https://api.axiom.co/v1/datasets/_apl/query`
- Dashboard: https://app.axiom.co

### Cloudflare Worker
- Worker: `savely-api` (internal name retained post-rebrand; served from `api.carddeals.co`) (account `901cf95153f15fa92fd91f2fc4a19c77`)
- KV namespace: `KV` (id `66ad293921d54eaa8859d5ac4befd993`)
- Cron: `*/15 * * * *` — invokes the `scheduled()` handler in `src/index.ts`

### Secrets (on the Worker)
- `AXIOM_TOKEN` — Axiom API token with Ingest + Query on `savely_events` (rename to `carddeals_events` still pending)
- `AXIOM_DATASET` — dataset name (currently `savely_events`)

## Event schema

All events in the `savely_events` dataset share a common shape. Every event has `_time` (auto-set), `event` (string), and event-specific fields.

### `event: "view"`
Sent by the **extension** via `GET /offers` (tagged source implicit since no explicit source field set by the Worker) and by the **website** (`source: "website"`) when a user lands on `/brands/[slug]`.

| Field        | Type   | Notes |
|--------------|--------|-------|
| viewer_id    | string | Extension installation ID (ext only) |
| session_id   | string | Website session ID (web only) |
| brand_id     | string | Extension only (web uses slug) |
| brand_slug   | string | Present in both sources — used for aggregation |
| brand_name   | string | Extension only |
| domain       | string | Extension only |
| source       | string | "website" for web events, omitted for ext |

### Website-only events (source: "website")

| Event                   | Fields |
|-------------------------|--------|
| `search`                | query, result_count |
| `search_result_click`   | query, brand_slug, brand_name |
| `offer_click`           | brand_slug, brand_id, provider_slug, provider_name, discount_percent, is_best_offer |
| `category_filter`       | category, added |
| `discount_filter`       | range, added |
| `waitlist_signup`       | source |
| `price_alert_created`   | brand_slug, brand_name, target_discount |
| `signup`                | method |
| `login`                 | method |

### `event: "offer_click" / "offer_impression" / "modal_opened" / "modal_shown" / "side_tab_click" / "side_tab_shown"`
Sent by `POST /events` from the extension.

| Field             | Type            |
|-------------------|-----------------|
| viewer_id         | string          |
| brand_id          | string \| null  |
| provider_id       | string \| null  |
| provider_slug     | string \| null  |
| domain            | string \| null  |
| product_url       | string \| null  |
| discount_percent  | number \| null  |
| page_type         | string \| null  |
| extension_version | string \| null  |
| browser           | string \| null  |
| metadata          | object          |

### `event: "feedback"`
Sent by `POST /feedback` from the extension.

| Field             | Type            |
|-------------------|-----------------|
| rating            | string \| null  |
| message           | string \| null  |
| extension_version | string \| null  |
| browser           | string \| null  |

## Popular brands cron

Every 15 minutes, `handleScheduled()` in `src/index.ts` runs this APL query against Axiom:

```apl
['savely_events']
| where event == 'view'
| where _time > ago(24h)
| summarize view_count = count() by brand_id, brand_slug, brand_name
| order by view_count desc
| take 100
```

It then joins the result against `provider_brand_discounts` in Supabase (only active, in-stock brands), and writes the combined list to KV under the key `popular-brands` with a 1-hour TTL.

If Axiom returns no rows (e.g. first deploy before any events), the cron falls back to a top-discount list from Supabase so the endpoints still return something useful.

## Querying Axiom manually

Use the Axiom dashboard or the API. Example:

```bash
curl -X POST "https://api.axiom.co/v1/datasets/_apl/query?format=tabular" \
  -H "Authorization: Bearer $AXIOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "apl": "[\"savely_events\"] | where event == \"offer_click\" | where _time > ago(24h) | summarize clicks = count() by provider_slug | order by clicks desc"
  }'
```

Useful queries for the dashboard:

- **Top clicked providers**: `where event == 'offer_click' | summarize count() by provider_slug`
- **Daily active viewers**: `where event == 'view' | summarize dcount(viewer_id) by bin(_time, 1d)`
- **Click-through rate per brand**: ratio of `offer_click` to `offer_impression` grouped by `brand_id`
- **Extension version adoption**: `where isnotempty(extension_version) | summarize count() by extension_version`

## Operational

- **Check KV is populated**: `npx wrangler kv key get --binding=KV "popular-brands" --remote` (from `/Users/jamesb/Documents/savely-api`)
- **View Worker logs**: `npx wrangler tail` or the Observability tab in the CF dashboard
- **Trigger the cron manually for testing**: the cron runs on the CF schedule only; for a manual run, temporarily expose a protected HTTP endpoint that calls `handleScheduled(env)` or use `wrangler dev` locally

## Fallback behavior

If any piece fails, the system degrades gracefully:

- Axiom ingest fails silently (events are dropped, no user impact)
- Axiom query fails → cron falls back to DB top-discount list
- KV is empty → public endpoints fall back to a direct DB query (top-discount list)

This means the user-facing endpoints always return *something*, even if the analytics pipeline is partially down.

## What NOT to write to Axiom

Axiom is for event/analytics data, not source-of-truth data. Do not use it for:

- User accounts, auth, or any transactional data
- Brand/discount/product state (stays in Supabase)
- Anything that needs to be queried by ID or updated after the fact

## Cost envelope

- Axiom free tier: 500 GB/mo ingest, 30-day retention. At current event volumes this is ~50x our usage.
- CF Workers: scheduled handler runs 96×/day (4/hour). Free plan request quota is 100k/day, so the cron alone is ~0.1% of quota.
- KV free tier: 100k reads/day, 1k writes/day. The cron writes once every 15 min (~96/day), and reads are capped by our 10-min response cache, so we're well under.

If we ever exceed Axiom's free tier, the next tier is $25/mo for 1.5 TB.
