#!/usr/bin/env node
// Comprueba que la app puede leer lo que necesita de Supabase, sin
// arrancar Expo ni tocar un telefono. Usa la MISMA clave publicable que
// la app, asi que tambien verifica que las policies de RLS dejan pasar al
// rol anonimo.
//
//   pnpm --filter @juicebar/mobile check:supabase

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(projectRoot, '..', '..');

function parseEnvFile(filePath) {
  const out = {};
  if (!existsSync(filePath)) return out;
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (key !== '') out[key] = value;
  }
  return out;
}

const env = { ...process.env };
for (const file of [
  path.join(workspaceRoot, '.env'),
  path.join(workspaceRoot, '.env.local'),
  path.join(projectRoot, '.env'),
  path.join(projectRoot, '.env.local'),
]) {
  for (const [key, value] of Object.entries(parseEnvFile(file))) {
    if (process.env[key] === undefined) env[key] = value;
  }
}

const url = (env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
const key = (
  env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  ''
).trim();
const restaurantId = (
  env.EXPO_PUBLIC_RESTAURANT_ID ?? '11111111-1111-4111-8111-111111111111'
).trim();

if (url === '' || key === '') {
  console.error('Faltan EXPO_PUBLIC_SUPABASE_URL y/o EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
  console.error('Copia apps/mobile/.env.example a .env.local y rellenalos.');
  process.exit(1);
}

if (key.startsWith('sb_secret_') || /"role"\s*:\s*"service_role"/.test(safeDecodeJwt(key))) {
  console.error('ALTO: esa es la clave SECRETA. La app solo puede usar la publicable.');
  process.exit(1);
}

function safeDecodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return '';
  try {
    return Buffer.from(parts[1], 'base64').toString('utf8');
  } catch {
    return '';
  }
}

async function query(pathAndQuery) {
  const response = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} — ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

const checks = [
  ['sucursal', `stores?id=eq.${storeId}&select=name,city,state,status`],
  ['categorias', `catalog_categories?store_id=eq.${storeId}&deleted_at=is.null&select=id`],
  ['menu (vista menu_items)', `menu_items?store_id=eq.${storeId}&select=id,name,price_cents`],
  ['destacados', `menu_items?store_id=eq.${storeId}&featured=is.true&select=id,name`],
  [
    'modificadores con recargo',
    `catalog_modifiers?store_id=eq.${storeId}&price_cents=gt.0&select=name,price_cents`,
  ],
];

let failed = false;

for (const [label, q] of checks) {
  try {
    const rows = await query(q);
    console.log(`  OK  ${label}: ${rows.length} fila(s)`);
    if (label === 'sucursal' && rows[0] !== undefined) {
      console.log(`      -> ${rows[0].name}, ${rows[0].city} (${rows[0].status})`);
    }
    if (label === 'modificadores con recargo') {
      for (const row of rows) {
        console.log(`      -> ${row.name}: +$${(row.price_cents / 100).toFixed(2)}`);
      }
    }
    if (rows.length === 0 && label !== 'destacados') {
      console.log('      (vacio: revisa que supabase/seed/seed_viva.sql este aplicado)');
    }
  } catch (cause) {
    failed = true;
    console.error(`  FALLA  ${label}: ${cause instanceof Error ? cause.message : cause}`);
  }
}

console.log(
  failed ? '\nHay comprobaciones en rojo.' : '\nTodo en verde: la app puede leer el menu.',
);
process.exit(failed ? 1 : 0);
