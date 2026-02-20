--
-- PostgreSQL database dump
--

-- Dumped from database version 17.7 (bdd1736)
-- Dumped by pg_dump version 17.7 (bdd1736)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: neondb_owner
--

-- *not* creating schema, since initdb creates it


ALTER SCHEMA public OWNER TO neondb_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: neondb_owner
--

COMMENT ON SCHEMA public IS '';


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: merge_brands(uuid, uuid); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.merge_brands(keep_id uuid, discard_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  -- Keep discard brand's name as alias on the canonical brand
  insert into brand_aliases (brand_id, alias)
  select keep_id, name
  from brands
  where id = discard_id
  on conflict do nothing;

  -- Move existing aliases from discard → keep
  insert into brand_aliases (brand_id, alias)
  select keep_id, alias
  from brand_aliases
  where brand_id = discard_id
  on conflict do nothing;

  -- Merge discounts: upsert then delete old
  insert into provider_brand_discounts (provider_id, brand_id, max_discount_percent, in_stock, fetched_at)
  select provider_id, keep_id, max_discount_percent, in_stock, fetched_at
  from provider_brand_discounts
  where brand_id = discard_id
  on conflict (provider_id, brand_id) do update
  set max_discount_percent = case
        when excluded.in_stock and not provider_brand_discounts.in_stock
          then excluded.max_discount_percent
        when provider_brand_discounts.in_stock and not excluded.in_stock
          then provider_brand_discounts.max_discount_percent
        else greatest(provider_brand_discounts.max_discount_percent, excluded.max_discount_percent)
      end,
      in_stock = provider_brand_discounts.in_stock or excluded.in_stock,
      fetched_at = greatest(provider_brand_discounts.fetched_at, excluded.fetched_at);

  delete from provider_brand_discounts
  where brand_id = discard_id;

  -- Merge products: update existing dest, then insert missing
  update provider_brand_products dest
  set is_active = dest.is_active or src.is_active,
      last_seen_at = greatest(dest.last_seen_at, src.last_seen_at),
      last_checked_at = greatest(dest.last_checked_at, src.last_checked_at),
      product_url = coalesce(src.product_url, dest.product_url)
  from provider_brand_products src
  where src.brand_id = discard_id
    and dest.provider_id = src.provider_id
    and dest.brand_id = keep_id
    and dest.variant = src.variant
    and coalesce(dest.product_external_id, '') = coalesce(src.product_external_id, '');

  insert into provider_brand_products
    (provider_id, brand_id, variant, product_external_id, product_url, is_active,
     first_seen_at, last_seen_at, last_checked_at, last_status, last_error, retry_count)
  select src.provider_id, keep_id, src.variant, src.product_external_id, src.product_url, src.is_active,
         src.first_seen_at, src.last_seen_at, src.last_checked_at, src.last_status, src.last_error, src.retry_count
  from provider_brand_products src
  where src.brand_id = discard_id
    and not exists (
      select 1
      from provider_brand_products dest
      where dest.provider_id = src.provider_id
        and dest.brand_id = keep_id
        and dest.variant = src.variant
        and coalesce(dest.product_external_id, '') = coalesce(src.product_external_id, '')
    );

  -- Repoint listings
  update provider_brand_listings
  set brand_id = keep_id
  where brand_id = discard_id;

  -- Finally, remove the old brand (cascades its remaining aliases/products)
  delete from brands
  where id = discard_id;
end;
$$;


ALTER FUNCTION public.merge_brands(keep_id uuid, discard_id uuid) OWNER TO neondb_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: brand_aliases; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    alias text NOT NULL
);


ALTER TABLE public.brand_aliases OWNER TO neondb_owner;

--
-- Name: brand_classifications; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_classifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    category_id uuid,
    iab_category_raw text,
    iab_confidence numeric(4,3),
    classified_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'klazify'::text
);


ALTER TABLE public.brand_classifications OWNER TO neondb_owner;

--
-- Name: brand_daily_viewers; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_daily_viewers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    viewer_id text NOT NULL,
    day date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.brand_daily_viewers OWNER TO neondb_owner;

--
-- Name: brand_domain_candidates; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_domain_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    candidate_domain public.citext NOT NULL,
    score numeric(6,4),
    google_rank integer,
    title text,
    raw_url text,
    is_filtered boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.brand_domain_candidates OWNER TO neondb_owner;

--
-- Name: brand_domain_failures; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_domain_failures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    reason text,
    last_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 1 NOT NULL
);


ALTER TABLE public.brand_domain_failures OWNER TO neondb_owner;

--
-- Name: brand_domain_reviews; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_domain_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    chosen_domain public.citext NOT NULL,
    score numeric(6,4) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewer_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone
);


ALTER TABLE public.brand_domain_reviews OWNER TO neondb_owner;

--
-- Name: brand_domains; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    domain public.citext NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.brand_domains OWNER TO neondb_owner;

--
-- Name: brand_events; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    event_type text NOT NULL,
    source text NOT NULL,
    domain public.citext,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.brand_events OWNER TO neondb_owner;

--
-- Name: brand_redeemable_domains; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brand_redeemable_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    domain public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.brand_redeemable_domains OWNER TO neondb_owner;

--
-- Name: brands; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.brands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    base_domain public.citext,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category_id uuid,
    description text
);


ALTER TABLE public.brands OWNER TO neondb_owner;

--
-- Name: categories; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    icon_name text NOT NULL,
    tone text,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.categories OWNER TO neondb_owner;

--
-- Name: extension_events; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.extension_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    viewer_id text NOT NULL,
    event_type text NOT NULL,
    brand_id uuid,
    provider_id uuid,
    provider_slug text,
    domain public.citext,
    product_url text,
    discount_percent numeric(5,2),
    extension_version text,
    browser text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_extension_events_type CHECK ((event_type = ANY (ARRAY['offer_click'::text, 'offer_impression'::text, 'modal_opened'::text, 'side_tab_click'::text])))
);


ALTER TABLE public.extension_events OWNER TO neondb_owner;

--
-- Name: offer_inventory_snapshots; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.offer_inventory_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_at timestamp with time zone NOT NULL,
    provider_id uuid NOT NULL,
    live_offer_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.offer_inventory_snapshots OWNER TO neondb_owner;

--
-- Name: provider_brand_discount_history; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.provider_brand_discount_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    max_discount_percent numeric(5,2) NOT NULL,
    in_stock boolean NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.provider_brand_discount_history OWNER TO neondb_owner;

--
-- Name: provider_brand_discounts; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.provider_brand_discounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    max_discount_percent numeric(5,2) NOT NULL,
    in_stock boolean DEFAULT true NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.provider_brand_discounts OWNER TO neondb_owner;

--
-- Name: provider_brand_listings; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.provider_brand_listings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    product_id uuid,
    face_value_cents integer NOT NULL,
    price_cents integer NOT NULL,
    fees_cents integer DEFAULT 0,
    in_stock boolean DEFAULT true NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    discount_percent numeric(5,2) GENERATED ALWAYS AS (
CASE
    WHEN (face_value_cents > 0) THEN round((((1)::numeric - ((price_cents)::numeric / (face_value_cents)::numeric)) * (100)::numeric), 2)
    ELSE NULL::numeric
END) STORED
);


ALTER TABLE public.provider_brand_listings OWNER TO neondb_owner;

--
-- Name: provider_brand_products; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.provider_brand_products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid NOT NULL,
    brand_id uuid NOT NULL,
    variant text NOT NULL,
    product_external_id text,
    product_url text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    last_checked_at timestamp with time zone,
    last_status text,
    last_error text,
    retry_count integer DEFAULT 0 NOT NULL,
    discount_percent numeric(5,2),
    CONSTRAINT chk_pbp_variant CHECK ((variant = ANY (ARRAY['online'::text, 'in_store'::text, 'other'::text])))
);


ALTER TABLE public.provider_brand_products OWNER TO neondb_owner;

--
-- Name: providers; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    affiliate_network text,
    deep_link_template text,
    api_base_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.providers OWNER TO neondb_owner;

--
-- Name: user_feedback; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.user_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rating text,
    message text,
    extension_version text,
    browser text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_user_feedback_rating CHECK (((rating IS NULL) OR (rating = ANY (ARRAY['very-bad'::text, 'bad'::text, 'neutral'::text, 'good'::text, 'very-good'::text]))))
);


ALTER TABLE public.user_feedback OWNER TO neondb_owner;

--
-- Name: v_brand_daily_viewers; Type: VIEW; Schema: public; Owner: neondb_owner
--

CREATE VIEW public.v_brand_daily_viewers AS
 SELECT bdv.id,
    bdv.brand_id,
    b.name AS brand_name,
    b.slug AS brand_slug,
    b.base_domain AS brand_base_domain,
    bdv.viewer_id,
    bdv.day AS view_date,
    bdv.created_at
   FROM (public.brand_daily_viewers bdv
     JOIN public.brands b ON ((b.id = bdv.brand_id)))
  ORDER BY bdv.day DESC, b.name, bdv.viewer_id;


ALTER VIEW public.v_brand_daily_viewers OWNER TO neondb_owner;

--
-- Name: v_brand_provider_offers; Type: VIEW; Schema: public; Owner: neondb_owner
--

CREATE VIEW public.v_brand_provider_offers AS
 SELECT b.id AS brand_id,
    b.name AS brand_name,
    b.slug AS brand_slug,
    b.base_domain,
    p.id AS provider_id,
    p.name AS provider_name,
    p.slug AS provider_slug,
    COALESCE(pbp.discount_percent, pbd.max_discount_percent) AS max_discount_percent,
    COALESCE(pbp.is_active, pbd.in_stock) AS in_stock,
    pbd.fetched_at,
    pbp.product_url,
    pbp.variant
   FROM (((public.provider_brand_discounts pbd
     JOIN public.brands b ON ((b.id = pbd.brand_id)))
     JOIN public.providers p ON ((p.id = pbd.provider_id)))
     LEFT JOIN public.provider_brand_products pbp ON (((pbp.provider_id = pbd.provider_id) AND (pbp.brand_id = pbd.brand_id) AND (pbp.is_active = true))));


ALTER VIEW public.v_brand_provider_offers OWNER TO neondb_owner;

--
-- Name: brand_aliases brand_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_aliases
    ADD CONSTRAINT brand_aliases_pkey PRIMARY KEY (id);


--
-- Name: brand_classifications brand_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_classifications
    ADD CONSTRAINT brand_classifications_pkey PRIMARY KEY (id);


--
-- Name: brand_domain_candidates brand_domain_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_domain_candidates
    ADD CONSTRAINT brand_domain_candidates_pkey PRIMARY KEY (id);


--
-- Name: brand_domain_failures brand_domain_failures_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_domain_failures
    ADD CONSTRAINT brand_domain_failures_pkey PRIMARY KEY (id);


--
-- Name: brand_domain_reviews brand_domain_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_domain_reviews
    ADD CONSTRAINT brand_domain_reviews_pkey PRIMARY KEY (id);


--
-- Name: brand_domains brand_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_domains
    ADD CONSTRAINT brand_domains_pkey PRIMARY KEY (id);


--
-- Name: brand_events brand_events_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_events
    ADD CONSTRAINT brand_events_pkey PRIMARY KEY (id);


--
-- Name: brand_redeemable_domains brand_redeemable_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_redeemable_domains
    ADD CONSTRAINT brand_redeemable_domains_pkey PRIMARY KEY (id);


--
-- Name: brands brands_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_pkey PRIMARY KEY (id);


--
-- Name: brands brands_slug_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_slug_key UNIQUE (slug);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);


--
-- Name: extension_events extension_events_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.extension_events
    ADD CONSTRAINT extension_events_pkey PRIMARY KEY (id);


--
-- Name: offer_inventory_snapshots offer_inventory_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.offer_inventory_snapshots
    ADD CONSTRAINT offer_inventory_snapshots_pkey PRIMARY KEY (id);


--
-- Name: provider_brand_discount_history provider_brand_discount_history_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_discount_history
    ADD CONSTRAINT provider_brand_discount_history_pkey PRIMARY KEY (id);


--
-- Name: provider_brand_discounts provider_brand_discounts_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_discounts
    ADD CONSTRAINT provider_brand_discounts_pkey PRIMARY KEY (id);


--
-- Name: provider_brand_listings provider_brand_listings_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_listings
    ADD CONSTRAINT provider_brand_listings_pkey PRIMARY KEY (id);


--
-- Name: provider_brand_products provider_brand_products_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_products
    ADD CONSTRAINT provider_brand_products_pkey PRIMARY KEY (id);


--
-- Name: providers providers_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);


--
-- Name: providers providers_slug_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_slug_key UNIQUE (slug);


--
-- Name: user_feedback user_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_feedback
    ADD CONSTRAINT user_feedback_pkey PRIMARY KEY (id);


--
-- Name: idx_brand_daily_viewers_brand_day; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_brand_daily_viewers_brand_day ON public.brand_daily_viewers USING btree (brand_id, day);


--
-- Name: idx_brand_daily_viewers_created_at; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_brand_daily_viewers_created_at ON public.brand_daily_viewers USING btree (created_at);


--
-- Name: idx_brand_events_brand_time; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_brand_events_brand_time ON public.brand_events USING btree (brand_id, created_at DESC);


--
-- Name: idx_brand_events_created_at; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_brand_events_created_at ON public.brand_events USING btree (created_at DESC);


--
-- Name: idx_brand_redeemable_by_domain; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_brand_redeemable_by_domain ON public.brand_redeemable_domains USING btree (lower((domain)::text));


--
-- Name: idx_brands_base_domain_lower_active; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_brands_base_domain_lower_active ON public.brands USING btree (lower((base_domain)::text)) WHERE (status = 'active'::text);


--
-- Name: idx_brands_category; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_brands_category ON public.brands USING btree (category_id) WHERE (category_id IS NOT NULL);


--
-- Name: idx_extension_events_brand; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_extension_events_brand ON public.extension_events USING btree (brand_id) WHERE (brand_id IS NOT NULL);


--
-- Name: idx_extension_events_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_extension_events_created ON public.extension_events USING btree (created_at DESC);


--
-- Name: idx_extension_events_domain; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_extension_events_domain ON public.extension_events USING btree (domain) WHERE (domain IS NOT NULL);


--
-- Name: idx_extension_events_provider; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_extension_events_provider ON public.extension_events USING btree (provider_id) WHERE (provider_id IS NOT NULL);


--
-- Name: idx_extension_events_type; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_extension_events_type ON public.extension_events USING btree (event_type);


--
-- Name: idx_extension_events_viewer; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_extension_events_viewer ON public.extension_events USING btree (viewer_id);


--
-- Name: idx_pbd_brand; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_pbd_brand ON public.provider_brand_discounts USING btree (brand_id, max_discount_percent DESC);


--
-- Name: idx_pbdh_brand_time; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_pbdh_brand_time ON public.provider_brand_discount_history USING btree (brand_id, observed_at);


--
-- Name: idx_pbdh_provider_brand_time; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_pbdh_provider_brand_time ON public.provider_brand_discount_history USING btree (provider_id, brand_id, observed_at);


--
-- Name: idx_pbl_brand_provider_fetched; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_pbl_brand_provider_fetched ON public.provider_brand_listings USING btree (brand_id, provider_id, fetched_at DESC);


--
-- Name: idx_user_feedback_created_at; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_user_feedback_created_at ON public.user_feedback USING btree (created_at DESC);


--
-- Name: idx_user_feedback_rating; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_user_feedback_rating ON public.user_feedback USING btree (rating);


--
-- Name: uq_brand_alias_per_brand; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_brand_alias_per_brand ON public.brand_aliases USING btree (brand_id, lower(alias));


--
-- Name: uq_brand_daily_viewers_unique; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_brand_daily_viewers_unique ON public.brand_daily_viewers USING btree (brand_id, viewer_id, day);


--
-- Name: uq_brand_domain_candidate_per_brand; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_brand_domain_candidate_per_brand ON public.brand_domain_candidates USING btree (brand_id, candidate_domain);


--
-- Name: uq_brand_domain_failure_per_brand; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_brand_domain_failure_per_brand ON public.brand_domain_failures USING btree (brand_id);


--
-- Name: uq_brand_domain_review_per_brand; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_brand_domain_review_per_brand ON public.brand_domain_reviews USING btree (brand_id);


--
-- Name: uq_brand_domain_unique; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_brand_domain_unique ON public.brand_domains USING btree (lower((domain)::text));


--
-- Name: uq_brand_redeemable_per_brand_domain; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_brand_redeemable_per_brand_domain ON public.brand_redeemable_domains USING btree (brand_id, lower((domain)::text));


--
-- Name: uq_brands_name_lower; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_brands_name_lower ON public.brands USING btree (lower(name));


--
-- Name: uq_offer_inventory_snapshot_provider_time; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_offer_inventory_snapshot_provider_time ON public.offer_inventory_snapshots USING btree (provider_id, snapshot_at);


--
-- Name: uq_pbp_provider_brand_variant_external; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_pbp_provider_brand_variant_external ON public.provider_brand_products USING btree (provider_id, brand_id, variant, COALESCE(product_external_id, ''::text));


--
-- Name: uq_provider_brand; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_provider_brand ON public.provider_brand_discounts USING btree (provider_id, brand_id);


--
-- Name: brand_aliases brand_aliases_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_aliases
    ADD CONSTRAINT brand_aliases_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_classifications brand_classifications_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_classifications
    ADD CONSTRAINT brand_classifications_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_classifications brand_classifications_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_classifications
    ADD CONSTRAINT brand_classifications_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: brand_domain_candidates brand_domain_candidates_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_domain_candidates
    ADD CONSTRAINT brand_domain_candidates_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_domain_failures brand_domain_failures_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_domain_failures
    ADD CONSTRAINT brand_domain_failures_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_domain_reviews brand_domain_reviews_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_domain_reviews
    ADD CONSTRAINT brand_domain_reviews_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_domains brand_domains_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_domains
    ADD CONSTRAINT brand_domains_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_events brand_events_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_events
    ADD CONSTRAINT brand_events_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_redeemable_domains brand_redeemable_domains_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brand_redeemable_domains
    ADD CONSTRAINT brand_redeemable_domains_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brands brands_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: extension_events extension_events_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.extension_events
    ADD CONSTRAINT extension_events_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE SET NULL;


--
-- Name: extension_events extension_events_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.extension_events
    ADD CONSTRAINT extension_events_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE SET NULL;


--
-- Name: offer_inventory_snapshots offer_inventory_snapshots_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.offer_inventory_snapshots
    ADD CONSTRAINT offer_inventory_snapshots_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;


--
-- Name: provider_brand_discount_history provider_brand_discount_history_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_discount_history
    ADD CONSTRAINT provider_brand_discount_history_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: provider_brand_discount_history provider_brand_discount_history_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_discount_history
    ADD CONSTRAINT provider_brand_discount_history_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;


--
-- Name: provider_brand_discounts provider_brand_discounts_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_discounts
    ADD CONSTRAINT provider_brand_discounts_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: provider_brand_discounts provider_brand_discounts_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_discounts
    ADD CONSTRAINT provider_brand_discounts_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;


--
-- Name: provider_brand_listings provider_brand_listings_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_listings
    ADD CONSTRAINT provider_brand_listings_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: provider_brand_listings provider_brand_listings_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_listings
    ADD CONSTRAINT provider_brand_listings_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.provider_brand_products(id);


--
-- Name: provider_brand_listings provider_brand_listings_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_listings
    ADD CONSTRAINT provider_brand_listings_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;


--
-- Name: provider_brand_products provider_brand_products_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_products
    ADD CONSTRAINT provider_brand_products_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: provider_brand_products provider_brand_products_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.provider_brand_products
    ADD CONSTRAINT provider_brand_products_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: neondb_owner
--

REVOKE USAGE ON SCHEMA public FROM PUBLIC;


--
-- PostgreSQL database dump complete
--

