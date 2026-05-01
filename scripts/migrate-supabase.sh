#!/usr/bin/env bash
# One-shot migration from old Supabase project -> new Supabase project.
#
# Use either:
#   - Direct connection:  postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres   (IPv6-only on free tier)
#   - Session Pooler:     postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres
#
# Do NOT use the Transaction Pooler (port 6543) — it runs in transaction mode
# and doesn't support the multi-statement DDL / COPY operations pg_dump emits.
#
# USAGE:
#   Preferred (clean, no terminal scrollback exposure):
#     export OLD_DATABASE_URL='postgresql://...'
#     export NEW_DATABASE_URL='postgresql://...'
#     ./scripts/migrate-supabase.sh
#
#   Or run interactively — it will prompt and echo a masked confirmation.

set -euo pipefail

mask_url() {
  # postgresql://user:password@host:port/db -> postgresql://user:***@host:port/db
  echo "$1" | sed -E 's#://([^:]+):[^@]+@#://\1:***@#'
}

prompt_for_url() {
  local var_name="$1"
  local label="$2"
  local val
  printf "%s\n  paste URL and press Enter: " "$label" >&2
  IFS= read -r val
  printf -v "$var_name" "%s" "$val"
}

OLD_URL="${OLD_DATABASE_URL:-}"
NEW_URL="${NEW_DATABASE_URL:-}"

[[ -z "$OLD_URL" ]] && prompt_for_url OLD_URL "OLD (current prod) DATABASE_URL"
[[ -z "$NEW_URL" ]] && prompt_for_url NEW_URL "NEW (just-created) DATABASE_URL"

# Validate
for url_var in OLD_URL NEW_URL; do
  url="${!url_var}"
  if [[ -z "$url" ]]; then
    echo "ERROR: $url_var is empty." >&2
    exit 1
  fi
  if [[ "$url" != postgresql://* && "$url" != postgres://* ]]; then
    echo "ERROR: $url_var doesn't start with postgresql:// — got: ${url:0:30}..." >&2
    exit 1
  fi
  if [[ "$url" == *":6543"* ]]; then
    echo "ERROR: $url_var is the Transaction Pooler (port 6543)." >&2
    echo "Use Direct (port 5432) or Session Pooler (port 5432)." >&2
    exit 1
  fi
  if [[ "$url" == *"YOUR-PASSWORD"* || "$url" == *"[YOUR-PASSWORD]"* ]]; then
    echo "ERROR: $url_var still has the [YOUR-PASSWORD] placeholder. Replace it with the real password." >&2
    exit 1
  fi
done

echo
echo "OLD: $(mask_url "$OLD_URL")"
echo "NEW: $(mask_url "$NEW_URL")"
echo

echo "[0/5] Testing connections to both DBs..."
if ! psql "$OLD_URL" -c 'select 1 as ok' >/dev/null 2>&1; then
  echo "ERROR: cannot connect to OLD DB. Try the Session Pooler URL if you're on IPv4." >&2
  psql "$OLD_URL" -c 'select 1 as ok' || true
  exit 1
fi
if ! psql "$NEW_URL" -c 'select 1 as ok' >/dev/null 2>&1; then
  echo "ERROR: cannot connect to NEW DB. Try the Session Pooler URL if you're on IPv4." >&2
  psql "$NEW_URL" -c 'select 1 as ok' || true
  exit 1
fi
echo "  both ok"

WORK="$(mktemp -d -t carddeals-migrate.XXXX)"
echo "Workspace: $WORK"

echo
echo "[1/5] Enabling required extensions on NEW DB..."
psql "$NEW_URL" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists citext;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;
SQL

echo
echo "[2/5] Dumping schema from OLD DB (public schema only, no owners/ACLs)..."
# Strip "CREATE SCHEMA public" since Supabase pre-creates the public schema.
pg_dump \
  --schema-only \
  --no-owner --no-acl --no-comments \
  --no-publications --no-subscriptions \
  --schema=public \
  "$OLD_URL" \
  | grep -vE '^CREATE SCHEMA public;$' \
  > "$WORK/schema.sql"
echo "  $(wc -l < "$WORK/schema.sql") lines, $(du -h "$WORK/schema.sql" | cut -f1)"

echo
echo "[3/5] Restoring schema to NEW DB..."
psql "$NEW_URL" -v ON_ERROR_STOP=1 -f "$WORK/schema.sql" > "$WORK/schema-restore.log" 2>&1 \
  || { echo "Schema restore failed. Last 30 lines:"; tail -30 "$WORK/schema-restore.log"; exit 1; }
echo "  ok ($(wc -l < "$WORK/schema-restore.log") lines logged to $WORK/schema-restore.log)"

echo
echo "[4/5] Dumping + restoring data (this is the egress-heavy step)..."
# No --disable-triggers: Supabase's postgres role isn't superuser. pg_dump
# orders COPY statements by FK dependency, so triggers firing on insert is
# generally fine.
pg_dump \
  --data-only \
  --no-owner --no-acl \
  --schema=public \
  "$OLD_URL" \
  | psql "$NEW_URL" -v ON_ERROR_STOP=1 > "$WORK/data-restore.log" 2>&1 \
  || { echo "Data restore failed. Last 30 lines:"; tail -30 "$WORK/data-restore.log"; exit 1; }
echo "  ok"

echo
echo "[5/5] Verifying table row counts on NEW DB..."
psql "$NEW_URL" -c "
  select relname as table_name, n_live_tup as rows, pg_size_pretty(pg_total_relation_size(relid)) as size
  from pg_stat_user_tables
  where schemaname = 'public'
  order by n_live_tup desc
  limit 30;
"

echo
echo "Done. Workspace kept at $WORK for debugging."
echo "Next: build the pooler URL (port 6543) and run the smoke test before flipping the worker."
