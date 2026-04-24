# HTTP API

This document describes the HTTP API implemented in `src/index.ts`. It is exposed as a Cloudflare Worker and primarily serves the browser extension.

## Overview

- Read-only API backed by a PostgreSQL database (`DATABASE_URL`).
- Routes are implemented with Hono in `src/index.ts`.
- Current public routes:
  - `GET /health`
  - `GET /popular-brands`
  - `GET /offers` (extension-only, API key–protected)

The exact base URL depends on your Cloudflare/Wrangler configuration (for example, a `*.workers.dev` subdomain or a custom domain). In local development, Wrangler typically serves on `http://127.0.0.1:8787`.

## Environment and Auth

### Environment variables

- `DATABASE_URL`  
  PostgreSQL connection string used by the app via `getDb`. Required for all database-backed endpoints.

- `EXTENSION_API_KEY`  
  Secret API key used to protect the `/offers` endpoint. When set, all `/offers` traffic must include a matching header:

  - Header name: `X-Extension-Key`
  - Value: exactly the value of `EXTENSION_API_KEY`

  If `EXTENSION_API_KEY` is missing, `/offers` returns `500` with:

  ```json
  { "error": "Server misconfigured: missing EXTENSION_API_KEY" }
  ```

### Authentication

- `/health` and `/popular-brands` are currently unauthenticated.
- `/offers` requires:

  - `X-Extension-Key: <EXTENSION_API_KEY>`
  - On mismatch or missing header, returns `401`:

    ```json
    { "error": "Unauthorized" }
    ```

## Caching

The `/offers` endpoint uses the Cloudflare Worker `caches.default` API:

- Cache key: the full request URL (method `GET`).
- TTL: 30 seconds (`OFFERS_CACHE_TTL_MS = 30_000`).
- Cached responses include a header `X-Cardbay-Cache-At` with a Unix timestamp in milliseconds.
- Subsequent identical requests within 30 seconds are served from cache if:
  - `Date.now() - X-Cardbay-Cache-At < 30_000`.

## Endpoints

### GET /health

Basic health check.

- **Method:** `GET`
- **Path:** `/health`
- **Auth:** none
- **Request body:** none
- **Response:**
  - Status: `200`
  - Content type: `text/plain`
  - Body: `ok`

### GET /popular-brands

Returns brands ordered by how many relevant events they had in the last _N_ hours, based on the `brand_events` table with `event_type = 'offer_view'`.

- **Method:** `GET`
- **Path:** `/popular-brands`
- **Auth:** none
- **Query params:**

  - `window_hours` (optional, integer)
    - Time window, in hours, to look back from `now()`.
    - Default: `24`
    - Min: `1`
    - Max: `168`
  - `limit` (optional, integer)
    - Max number of brands to return.
    - Default: `20`
    - Min: `1`
    - Max: `100`

- **Response (200):**

  ```jsonc
  {
    "window_hours": 24,
    "limit": 20,
    "brands": [
      {
        "id": "uuid-or-id",
        "name": "Best Buy",
        "slug": "best-buy",
        "base_domain": "bestbuy.com",
        "event_count": 42
      }
    ]
  }
  ```

  - `window_hours` — the effective window used after clamping.
  - `limit` — the effective limit used after clamping.
  - `brands` — ordered by:
    1. `event_count` (descending)
  - `event_count` — number of matching `brand_events` rows per brand for:
    - `event_type = 'offer_view'`
    - `created_at >= now() - (window_hours * interval '1 hour')`

### GET /offers

Main extension endpoint. For a given domain, returns:

- The canonical brand (if any).
- Available provider offers for that brand family and redeemable domains.
- A pre-computed `bestOffer`.

#### Summary

- **Method:** `GET`
- **Path:** `/offers`
- **Auth:** required (`X-Extension-Key`)
- **Query params:**
  - `domain` (required, string)
    - Hostname / base domain to resolve (e.g. `bestbuy.com`).
    - Used to:
      - Match `brand_domains.domain` (exact, case-insensitive).
      - Fallback to `brands.base_domain` (case-insensitive).
  - `in_store` (optional, string)
    - Controls filtering by offer variant:
      - `"true"` or `"1"` → only offers with `variant === "in_store"`.
      - `"false"` or `"0"` → only offers with `variant !== "in_store"`.
      - Any other value or omitted → no variant-based filtering.

#### Domain → Brand resolution

1. Look up `brand_domains` joined to `brands`:
   - `lower(brand_domains.domain) = lower(domain)`
   - `brands.status = 'active'`
   - Take the first match.
2. If none found, fall back to `brands` directly:
   - `lower(brands.base_domain) = lower(domain)`
   - `brands.status = 'active'`
   - Ordered by `brands.created_at`, take the first.
3. If there is still no match **or** the chosen brand has a null `base_domain`, the endpoint returns:

   ```json
   {
     "brand": null,
     "bestOffer": null,
     "offers": []
   }
   ```

#### Analytics side-effect

If a canonical brand is found, the endpoint records a `brand_events` row:

- `brand_id` — canonical brand id.
- `event_type` — `"offer_view"`.
- `source` — `"extension"`.
- `domain` — the requested domain string.

This insert is done in a fire-and-forget fashion using `executionCtx.waitUntil` when available.

#### Offer selection

After resolving the canonical brand and its `base_domain`:

1. Query `v_brand_provider_offers` joined to `brands` where:
   - `brands.status = 'active'`
   - `lower(brands.base_domain) = lower(canonical_base_domain)` **OR**
   - A row exists in `brand_redeemable_domains` for the brand with `lower(domain) = lower(requested domain)`.
2. Order rows by:
   1. `in_stock` (descending)
   2. `max_discount_percent` (descending, nulls last)
   3. `provider_name` (ascending)
3. If no rows are found, the response is:

   ```json
   {
     "brand": null,
     "bestOffer": null,
     "offers": []
   }
   ```

#### Response shape

On success (including “no offers” cases) the endpoint returns `200` with:

```jsonc
{
  "brand": {
    "id": "brand-id",
    "name": "Brand Name",
    "slug": "brand-slug",
    "base_domain": "example.com"
  },
  "bestOffer": {
    "provider": {
      "id": "provider-id",
      "name": "Provider Name",
      "slug": "provider-slug"
    },
    "max_discount_percent": 12.5,
    "in_stock": true,
    "fetched_at": "2025-11-11T20:15:00Z",
    "product_url": "https://provider.example/offer",
    "variant": "online",
    "variant_label": "Online"
  },
  "offers": [
    {
      "provider": {
        "id": "provider-id",
        "name": "Provider Name",
        "slug": "provider-slug"
      },
      "max_discount_percent": 12.5,
      "in_stock": true,
      "fetched_at": "2025-11-11T20:15:00Z",
      "product_url": "https://provider.example/offer",
      "variant": "online",
      "variant_label": "Online"
    }
  ]
}
```

Notes:

- `brand` — canonical brand for the domain; `null` if none.
- `offers` — only includes **clickable** offers:
  - `in_stock === true`
  - `product_url` is a non-empty string
  - `max_discount_percent` is non-null and `> 0`
- `bestOffer` — first element of `offers` (or `null`), taking advantage of the SQL ordering.
- `variant` — raw variant string from the DB, typically:
  - `"online"`
  - `"in_store"`
  - Other values or `null` are allowed.
- `variant_label` — human-friendly label derived from `variant`:
  - `"online"` → `"Online"`
  - `"in_store"` → `"In-store only"`
  - All other values / `null` → `null`

#### Error responses

- Missing `domain` query param:

  - Status: `400`
  - Body:

    ```json
    { "error": "Missing required query param: domain" }
    ```

- Missing or incorrect `X-Extension-Key`:

  - Status: `401`
  - Body:

    ```json
    { "error": "Unauthorized" }
    ```

- Server misconfiguration (missing `EXTENSION_API_KEY` in environment):

  - Status: `500`
  - Body:

    ```json
    { "error": "Server misconfigured: missing EXTENSION_API_KEY" }
    ```
