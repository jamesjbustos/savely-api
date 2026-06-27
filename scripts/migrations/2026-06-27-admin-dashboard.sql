-- Admin dashboard rebuild: audit log + unmatched-product matching queue.
-- Safe to re-run (IF NOT EXISTS everywhere).

-- 1) Audit trail for every mutating admin action.
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  actor_email text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON public.admin_audit_log (created_at DESC);

-- 2) Products the provider crons could NOT match to one of our brands.
--    Powers the admin "matching queue": approve -> insert brand_alias -> next
--    cron run attaches it automatically.
CREATE TABLE IF NOT EXISTS public.provider_unmatched_products (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id         uuid NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  product_external_id text NOT NULL,
  product_name        text NOT NULL,
  product_url         text,
  normalized_key      text,
  dismissed           boolean NOT NULL DEFAULT false,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_unmatched_provider_external
  ON public.provider_unmatched_products (provider_id, product_external_id);
CREATE INDEX IF NOT EXISTS idx_unmatched_active
  ON public.provider_unmatched_products (provider_id, last_seen_at DESC)
  WHERE dismissed = false;
