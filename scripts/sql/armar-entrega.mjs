#!/usr/bin/env node
/**
 * Arma el archivo .sql de una entrega: un solo archivo para pegar en
 * Supabase → SQL Editor → Run.
 *
 *   node scripts/sql/armar-entrega.mjs <salida.sql> [seed.sql ...]
 *
 * Qué lleva, en orden:
 *  1. Cada migración de supabase/migrations dentro de su propio bloque DO
 *     que primero mira `supabase_migrations.schema_migrations` (el mismo
 *     registro que usa `supabase db push`). Si ya está anotada, se salta;
 *     si no, se ejecuta y se anota. Por eso se puede correr dos veces.
 *  2. Los seeds que se pasen (ya son bloques DO idempotentes).
 *  3. `notify pgrst, 'reload schema'` para que la API vea las columnas
 *     nuevas sin esperar.
 *
 * El SQL Editor corre todo el archivo en UNA transacción: si algo falla,
 * no queda nada a medias.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [out, ...seeds] = process.argv.slice(2);
if (!out) {
  console.error('Uso: node scripts/sql/armar-entrega.mjs <salida.sql> [seed.sql ...]');
  process.exit(1);
}

const dir = join(root, 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

const parts = [];
parts.push(`-- =====================================================================
-- ${basename(out)}
-- Generado por scripts/sql/armar-entrega.mjs. No editar a mano.
--
-- Cómo correrlo: Supabase → SQL Editor → New query → pegar TODO el
-- archivo → Run. Se puede correr dos veces: lo que ya está, se salta.
-- Migraciones incluidas: ${files[0]} … ${files[files.length - 1]} (${files.length}).
-- =====================================================================

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version    text not null primary key,
  statements text[],
  name       text
);
`);

for (const file of files) {
  const version = file.slice(0, 4);
  const name = file.slice(5, -4);
  const tag = `$m${version}$`;
  const body = readFileSync(join(dir, file), 'utf8');
  if (body.includes(tag)) throw new Error(`${file} contiene ${tag}; cambia la etiqueta.`);
  parts.push(`-- ${file}
do $entrega$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '${version}') then
    raise notice 'Migración ${version} ya aplicada: se salta.';
    return;
  end if;
  execute ${tag}
${body}
${tag};
  insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name}');
  raise notice 'Migración ${version} aplicada.';
end
$entrega$;
`);
}

for (const seed of seeds) {
  parts.push(`-- ${basename(seed)}\n${readFileSync(seed, 'utf8')}\n`);
}

parts.push(`-- Que la API (PostgREST) vea ya las tablas y columnas nuevas.
notify pgrst, 'reload schema';
`);

writeFileSync(out, parts.join('\n'));
console.log(`Escrito ${out}: ${files.length} migraciones, ${seeds.length} seed(s).`);
