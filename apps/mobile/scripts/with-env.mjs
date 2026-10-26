#!/usr/bin/env node
// Carga las variables de entorno del monorepo antes de arrancar Expo.
//
// Motivo: se usa un unico `.env.local` en la
// raiz del repositorio. Expo, en cambio, solo lee los `.env*` que estan
// junto a `app.json`. Este envoltorio junta ambas cosas: lee primero la
// raiz y despues el directorio de la app, de forma que lo local gana.
//
// Solo se propagan las claves publicas (EXPO_PUBLIC_*). Todo lo demas
// —service_role de Supabase, secretos de Clover— se queda fuera a
// proposito: si viajara al bundle seria un incidente de seguridad.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(projectRoot, '..', '..');

/** Parser minimo de .env: `CLAVE=valor`, comillas opcionales, `#` comenta. */
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

    // Un comentario al final solo cuenta si el valor no venia entrecomillado.
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

// De menor a mayor prioridad.
const files = [
  path.join(workspaceRoot, '.env'),
  path.join(workspaceRoot, '.env.local'),
  path.join(projectRoot, '.env'),
  path.join(projectRoot, '.env.local'),
];

const collected = {};
for (const file of files) Object.assign(collected, parseEnvFile(file));

const env = { ...process.env };
const loaded = [];
for (const [key, value] of Object.entries(collected)) {
  // El proceso real manda sobre el archivo, y nunca exportamos secretos.
  if (!key.startsWith('EXPO_PUBLIC_')) continue;
  if (process.env[key] !== undefined) continue;
  env[key] = value;
  loaded.push(key);
}

if (loaded.length > 0) {
  console.log(`[with-env] variables cargadas: ${loaded.join(', ')}`);
} else {
  console.log('[with-env] no se encontro ninguna EXPO_PUBLIC_* en .env.local');
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error('Uso: node scripts/with-env.mjs <comando> [args...]');
  process.exit(1);
}

const child = spawn(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
