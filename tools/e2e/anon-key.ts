// Imprime la clave anónima de prueba (la firma servidor.ts con su secreto).
import { createHmac } from 'node:crypto';
const secret = 'e2e-secreto-de-prueba-de-32-caracteres-o-mas';
const b64 = (s: string): string => Buffer.from(s).toString('base64url');
const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const body = b64(JSON.stringify({ iss: 'supabase', ref: 'e2e', role: 'anon', iat: 1700000000, exp: 2100000000 }));
process.stdout.write(`${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`);
