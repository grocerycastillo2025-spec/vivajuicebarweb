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

/** Enlace del QR de la app: abre la app con el aviso para instalarla. */
export function appInstallUrl(): string {
  return `${appPublicUrl()}/?instalar=1`;
}

function escapeHtml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
}

/**
 * Cartel tamaño carta para el mostrador: logo, QR de la app y texto en
 * inglés y español. Abre la ventana de impresión (también "Guardar como
 * PDF").
 */
export function printAppPoster(opts: {
  readonly url: string;
  readonly brand: string;
  readonly logoUrl: string | null;
  readonly color: string;
}): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const page = window.open('', '_blank');
  if (page === null) return;
  const brand = escapeHtml(opts.brand);
  const color = /^#[0-9a-f]{6}$/i.test(opts.color) ? opts.color : '#1F4D36';
  const logo =
    opts.logoUrl !== null && /^https?:\/\//.test(opts.logoUrl)
      ? `<img class="logo" src="${escapeHtml(opts.logoUrl)}" alt="${brand}">`
      : `<h1>${brand}</h1>`;
  page.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>QR · ${brand}</title>
<style>
  @page{size:letter;margin:0.5in}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:#111;text-align:center}
  .sheet{border:10px solid ${color};border-radius:28px;padding:36px 32px;min-height:9.6in;display:flex;flex-direction:column;align-items:center;justify-content:space-between}
  .band{background:${color};border-radius:16px;padding:18px 28px;display:inline-block}
  .logo{max-width:3.2in;max-height:1.4in;object-fit:contain;display:block}
  h1{font-size:40px;margin:0;color:#fff}
  h2{font-size:38px;margin:18px 0 4px;line-height:1.1}
  .es{font-size:26px;color:#444;margin:0}
  .qr{width:4.4in;margin:18px auto}
  .qr svg{width:100%;height:auto;display:block}
  .steps{display:flex;gap:28px;justify-content:center;font-size:17px;color:#333;margin-top:8px}
  .steps div{max-width:2.6in}
  .url{font-size:13px;color:#777;margin-top:14px;word-break:break-all}
  @media print{.band{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  @media screen{body{padding:24px;background:#eee}.sheet{background:#fff;max-width:8.5in;margin:0 auto}}
</style></head><body><div class="sheet">
<!-- El logo suele ser claro (para la app): va sobre el color de la marca. -->
<div class="band">${logo}</div>
<div>
  <h2>Order ahead &amp; earn rewards</h2>
  <p class="es">Pide desde tu teléfono y junta puntos</p>
</div>
<div class="qr">${qrSvg(opts.url)}</div>
<div class="steps">
  <div><b>1.</b> Scan with your camera<br><span style="color:#666">Escanea con tu cámara</span></div>
  <div><b>2.</b> Add to Home Screen<br><span style="color:#666">Agrégala a tu pantalla de inicio</span></div>
</div>
<div class="url">${escapeHtml(opts.url)}</div>
</div>
<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
</body></html>`);
  page.document.close();
}

/** Descarga el QR como PNG (para redes o para mandarlo a una imprenta). */
export function downloadQrPng(text: string, fileName: string): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const link = document.createElement('a');
  link.href = qrDataUrl(text, 16);
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
