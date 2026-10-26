#!/usr/bin/env bash
# Prueba de punta a punta en navegador, toda en esta máquina:
#   1. base nueva "e2e" que imita un proyecto de Supabase recién creado,
#      con el archivo de la entrega aplicado (igual que el dueño);
#   2. PostgREST de verdad + servidor.ts (Auth, funciones de cobro, Stripe y
#      PayPal falsos);
#   3. la app web exportada con la URL y la clave de este "Supabase";
#   4. recorrido.mjs con Playwright: cliente, dueño, cajero; capturas en
#      tools/e2e/capturas/.
#
# Requisitos: Postgres local (PGHOST/PGUSER/PGPASSWORD), postgrest en el PATH
# o en $POSTGREST, y Chromium de Playwright.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
export PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
POSTGREST="${POSTGREST:-postgrest}"
DB=e2e

echo "== Base"
psql -d postgres -qc "drop database if exists $DB with (force)" -c "create database $DB" >/dev/null
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/entorno/supabase-vacio.sql" >/dev/null
psql -d "$DB" -q -1 -v ON_ERROR_STOP=1 -f "$ROOT/entregas/01-base-viva-juice.sql" >/dev/null 2>&1
psql -d "$DB" -q -c "alter role authenticator with login password 'authenticator'" >/dev/null

echo "== Servicios"
cat > /tmp/e2e-postgrest.conf <<CONF
db-uri = "postgres://authenticator:authenticator@${PGHOST}:5432/${DB}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "e2e-secreto-de-prueba-de-32-caracteres-o-mas"
server-port = 3001
server-host = "127.0.0.1"
CONF
pkill -f "[p]ostgrest /tmp/e2e-postgrest.conf" 2>/dev/null || true
pkill -f "[s]trip-types $ROOT/tools/e2e/servidor" 2>/dev/null || true
"$POSTGREST" /tmp/e2e-postgrest.conf >/tmp/e2e-postgrest.log 2>&1 &
PGRST_PID=$!
node --experimental-strip-types "$ROOT/tools/e2e/servidor.ts" >/tmp/e2e-servidor.log 2>&1 &
SRV_PID=$!
# E2E_SOLO_LEVANTAR=1 deja todo corriendo (para explorar a mano).
if [ "${E2E_SOLO_LEVANTAR:-}" != "1" ]; then
  trap 'kill $PGRST_PID $SRV_PID 2>/dev/null || true' EXIT
fi

echo "== App web"
ANON="$(node --experimental-strip-types anon-key.ts)"
if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
  (cd "$ROOT/apps/mobile" && \
    EXPO_PUBLIC_SUPABASE_URL=http://localhost:54321 \
    EXPO_PUBLIC_SUPABASE_ANON_KEY="$ANON" \
    EXPO_PUBLIC_APP_ENV=e2e \
    EXPO_WEB_BASE_URL=/vivajuicebarweb \
    CI=1 pnpm build:web >/tmp/e2e-build.log 2>&1) || { tail -30 /tmp/e2e-build.log; exit 1; }
fi

for i in $(seq 1 30); do
  curl -s -o /dev/null http://127.0.0.1:3001/ && curl -s -o /dev/null http://localhost:8080/vivajuicebarweb/ && break
  sleep 1
done

if [ "${E2E_SOLO_LEVANTAR:-}" = "1" ]; then
  echo "Listo: app en http://localhost:8080/vivajuicebarweb/"; exit 0
fi

echo "== Recorrido en navegador"
rm -rf capturas && mkdir -p capturas
E2E_DB_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/${DB}" node recorrido.mjs
