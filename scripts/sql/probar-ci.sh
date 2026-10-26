#!/usr/bin/env bash
# Lo mismo que el job "database" del CI, en local:
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash scripts/sql/probar-ci.sh
set -euo pipefail
DB="${PROBAR_DB:-ci}"
psql -d postgres -qc "drop database if exists $DB" -c "create database $DB" >/dev/null
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f .github/db-harness.sql >/dev/null
for f in supabase/migrations/*.sql; do
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/probar-ci.err || { echo "FALLÓ $f"; cat /tmp/probar-ci.err; exit 1; }
done
for f in supabase/tests/*.test.sql; do
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$f" 2>&1 | grep -E "^OK|ERROR" || { echo "FALLÓ $f"; exit 1; }
done
