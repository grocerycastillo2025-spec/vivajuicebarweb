#!/usr/bin/env bash
# Prueba un archivo de entrega sobre una base que imita un proyecto de
# Supabase recién creado: lo corre DOS veces, cada una en una sola
# transacción (como el SQL Editor), y luego revisa lo que tiene que haber.
#
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
#     bash scripts/sql/probar-entrega.sh entregas/01-base-viva-juice.sql
set -euo pipefail
ENTREGA="${1:?Uso: probar-entrega.sh <entrega.sql>}"
DB="${PROBAR_DB:-entrega_prueba}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

psql -d postgres -qc "drop database if exists $DB" -c "create database $DB" >/dev/null
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/entorno/supabase-vacio.sql" >/dev/null

for vuelta in 1 2; do
  echo "== Vuelta $vuelta"
  psql -d "$DB" -q -1 -v ON_ERROR_STOP=1 -f "$ENTREGA" 2>&1 | grep -E "ERROR|aplicada\.|ya aplicada" | sort | uniq -c | sed 's/^/   /' || true
  # psql -1 con ON_ERROR_STOP sale con error si algo falla: lo repetimos
  # sin grep para que el código de salida cuente.
done
psql -d "$DB" -q -1 -v ON_ERROR_STOP=1 -f "$ENTREGA" >/dev/null 2>&1 || {
  echo "La tercera vuelta falló:"; psql -d "$DB" -q -1 -v ON_ERROR_STOP=1 -f "$ENTREGA" 2>&1 | grep -m3 ERROR; exit 1; }

psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/entorno/revisar-entrega.sql"
echo "OK: la entrega corre en una base vacía, se puede repetir y deja todo en su lugar."
