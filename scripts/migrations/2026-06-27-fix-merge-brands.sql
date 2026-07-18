-- Fix merge_brands(): the old body referenced provider_brand_listings (which
-- doesn't exist in this DB) and relied on cascade deletes for child rows that
-- aren't all ON DELETE CASCADE. Rewritten to move offers/aliases/discounts onto
-- the kept brand, then explicitly clear the discarded brand's child rows before
-- deleting it. Idempotent (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.merge_brands(keep_id uuid, discard_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $function$
begin
  -- Keep the discarded brand's name as an alias on the canonical brand
  insert into brand_aliases (brand_id, alias)
  select keep_id, name from brands where id = discard_id
  on conflict do nothing;

  -- Move discard's aliases → keep
  insert into brand_aliases (brand_id, alias)
  select keep_id, alias from brand_aliases where brand_id = discard_id
  on conflict do nothing;

  -- Merge discounts onto keep (upsert)
  insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
  select provider_id, keep_id, max_discount_percent, in_stock, fetched_at
  from provider_brand_discounts where brand_id = discard_id
  on conflict (provider_id, brand_id) do update
  set max_discount_percent = greatest(provider_brand_discounts.max_discount_percent, excluded.max_discount_percent),
      in_stock = provider_brand_discounts.in_stock or excluded.in_stock,
      fetched_at = greatest(provider_brand_discounts.fetched_at, excluded.fetched_at);

  -- Merge products: update the overlapping dest rows, then insert the rest onto keep
  update provider_brand_products dest
  set is_active = dest.is_active or src.is_active,
      last_seen_at = greatest(dest.last_seen_at, src.last_seen_at),
      last_checked_at = greatest(dest.last_checked_at, src.last_checked_at),
      product_url = coalesce(src.product_url, dest.product_url),
      discount_percent = coalesce(src.discount_percent, dest.discount_percent)
  from provider_brand_products src
  where src.brand_id = discard_id
    and dest.provider_id = src.provider_id and dest.brand_id = keep_id
    and dest.variant = src.variant
    and coalesce(dest.product_external_id, '') = coalesce(src.product_external_id, '');

  insert into provider_brand_products
    (provider_id, brand_id, variant, product_external_id, product_url, is_active,
     first_seen_at, last_seen_at, last_checked_at, last_status, last_error, retry_count, discount_percent)
  select src.provider_id, keep_id, src.variant, src.product_external_id, src.product_url, src.is_active,
         src.first_seen_at, src.last_seen_at, src.last_checked_at, src.last_status, src.last_error,
         src.retry_count, src.discount_percent
  from provider_brand_products src
  where src.brand_id = discard_id
    and not exists (
      select 1 from provider_brand_products dest
      where dest.provider_id = src.provider_id and dest.brand_id = keep_id
        and dest.variant = src.variant
        and coalesce(dest.product_external_id, '') = coalesce(src.product_external_id, '')
    );

  -- Clear the discarded brand's child rows, then remove the brand itself.
  delete from provider_brand_products where brand_id = discard_id;
  delete from provider_brand_discounts where brand_id = discard_id;
  delete from provider_brand_discount_history where brand_id = discard_id;
  delete from brand_aliases where brand_id = discard_id;
  delete from brand_domain_candidates where brand_id = discard_id;
  delete from brand_domain_reviews where brand_id = discard_id;
  delete from brand_domains where brand_id = discard_id;
  delete from brand_redeemable_domains where brand_id = discard_id;

  delete from brands where id = discard_id;
end;
$function$;
