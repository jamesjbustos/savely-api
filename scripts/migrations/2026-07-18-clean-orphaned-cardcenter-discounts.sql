-- Clean up orphaned CardCenter discounts: provider_brand_discounts rows that
-- have no matching provider_brand_products row (not even an inactive one).
--
-- Why these exist: discounts and products live in separate tables. The offer's
-- existence + percent come from provider_brand_discounts; the link comes from
-- provider_brand_products.product_url. The CardCenter cron always writes both
-- together and never deletes discount rows, but product rows CAN be deleted
-- (brand merges, variant cleanup). A merge run under the old, broken
-- merge_brands() (fixed 2026-06-27) could keep the discount on the surviving
-- brand while dropping its product row. The result is a "CardCenter 2%" offer
-- with a NULL product_url, shown in the admin dashboard as a discount with no
-- Preview link (e.g. Tot Squad).
--
-- The cron now self-heals this going forward (see runCardCenterCron in
-- src/cron.ts); this migration clears the orphans that already exist.

-- Inspect first (read-only): every orphaned discount, by provider.
--   select p.slug as provider, b.slug as brand, pbd.max_discount_percent, pbd.in_stock
--   from provider_brand_discounts pbd
--   join providers p on p.id = pbd.provider_id
--   join brands b on b.id = pbd.brand_id
--   where not exists (
--     select 1 from provider_brand_products pbp
--     where pbp.provider_id = pbd.provider_id and pbp.brand_id = pbd.brand_id
--   )
--   order by p.slug, b.slug;

-- Remove orphaned CardCenter discounts (scoped to CardCenter, whose ingest
-- guarantees a product per discount, so an orphan is unambiguously dead data).
delete from provider_brand_discounts pbd
using providers p
where p.id = pbd.provider_id
  and p.slug = 'cardcenter'
  and not exists (
    select 1 from provider_brand_products pbp
    where pbp.provider_id = pbd.provider_id
      and pbp.brand_id = pbd.brand_id
  );
