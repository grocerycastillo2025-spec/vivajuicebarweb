/**
 * QR del local: el enlace que lleva dentro y como pintarlo o imprimirlo.
 */

import Constants from 'expo-constants';
import qrcode from 'qrcode-generator';
import { Platform } from 'react-native';

/**
 * Raiz publica de la app web, que es a donde apunta el QR. En web se
 * toma de la propia pagina (sirve igual en GitHub Pages que con dominio
 * propio). Fuera de web hace falta `EXPO_PUBLIC_WEB_URL`.
 */
export function appPublicUrl(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const base = (Constants.expoConfig?.experiments as { baseUrl?: string } | undefined)?.baseUrl ?? '';
    return `${window.location.origin}${base}`;
  }
  return (process.env.EXPO_PUBLIC_WEB_URL ?? '').replace(/\/+$/, '');
}

function make(text: string): ReturnType<typeof qrcode> {
  // Correccion de errores M: aguanta algo de suciedad o un doblez en el
  // QR impreso sin volverse enorme.
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

/** Imagen (data URL) para ensenar en pantalla. */
export function qrDataUrl(text: string, cellSize = 8): string {
  return make(text).createDataURL(cellSize, 2);
}

/** SVG para imprimir: nitido a cualquier tamaño. */
export function qrSvg(text: string): string {
  return make(text).createSvgTag({ cellSize: 10, margin: 2, scalable: true });
}

/** Abre una hoja lista para imprimir con el QR y las instrucciones. */
export function printVisitQr(text: string, brand: string): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const page = window.open('', '_blank');
  if (page === null) return;
  const safeBrand = brand.replace(/[<>&"]/g, '');
  page.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>QR de visitas · ${safeBrand}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;margin:0;padding:40px;color:#111}
  h1{font-size:34px;margin:0 0 8px}
  p{font-size:20px;margin:0 0 24px}
  .qr{width:min(80vw,520px);margin:0 auto}
  .qr svg{width:100%;height:auto}
  small{display:block;margin-top:24px;font-size:14px;color:#555}
  @media print{body{padding:0}}
</style></head><body>
<h1>${safeBrand}</h1>
<p>Escanea con la app y suma puntos en cada visita</p>
<div class="qr">${qrSvg(text)}</div>
<small>Abre la app → Puntos → Escanear QR del local</small>
<script>window.onload=function(){window.print()}</script>
</body></html>`);
  page.document.close();
}
