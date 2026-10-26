/**
 * Cómo ofrecer "instalar la app" según el teléfono y el navegador.
 *
 * Ningún navegador deja que una página se instale sola: siempre confirma
 * la persona. Lo más cerca que se puede llegar:
 *   - Chrome / Edge / Samsung (Android y computadora): el navegador avisa
 *     con `beforeinstallprompt` y un botón nuestro abre su ventana de
 *     "Instalar". Un toque + confirmar.
 *   - iPhone / iPad: Apple no tiene ese aviso. Solo se puede enseñar los
 *     pasos (Compartir → Agregar a pantalla de inicio).
 *   - Navegadores dentro de otra app (WhatsApp, Instagram, Facebook,
 *     TikTok): no instalan nada. Hay que abrir la liga en Chrome o Safari.
 *
 * Funciones puras para poder probarlas sin navegador.
 */

export type InstallMode =
  /** Ya abierta como app instalada: no se ofrece nada. */
  | 'installed'
  /** El navegador ya dio su aviso: nuestro botón instala. */
  | 'prompt'
  /** iPhone/iPad en Safari (u otro navegador de iOS): enseñar los pasos. */
  | 'ios'
  /** Navegador dentro de WhatsApp/Instagram/Facebook/TikTok. */
  | 'in_app'
  /** Android sin aviso (todavía): enseñar el menú del navegador. */
  | 'android_manual'
  /** Computadora sin aviso: no estorbar. */
  | 'none';

export type Platform = 'ios' | 'android' | 'other';

export function platformOf(userAgent: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  // iPadOS se presenta como Mac de escritorio; se distingue por el tactil.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'other';
}

export function isInAppBrowser(userAgent: string): boolean {
  return /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|musical_ly|BytedanceWebview|TikTok|Snapchat|Twitter/i.test(
    userAgent,
  );
}

export function installMode(input: {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
  readonly standalone: boolean;
  readonly hasPrompt: boolean;
}): InstallMode {
  if (input.standalone) return 'installed';
  if (input.hasPrompt) return 'prompt';
  if (isInAppBrowser(input.userAgent)) return 'in_app';
  const platform = platformOf(input.userAgent, input.maxTouchPoints ?? 0);
  if (platform === 'ios') return 'ios';
  if (platform === 'android') return 'android_manual';
  return 'none';
}

/** Días que se esconde el aviso después de "Ahora no". */
export const DISMISS_DAYS = 14;

export function dismissedRecently(dismissedAt: number | null, now: number): boolean {
  if (dismissedAt === null || !Number.isFinite(dismissedAt)) return false;
  return now - dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

/** La liga del QR trae `?instalar=1`: ahí el aviso sale aunque lo hayan cerrado. */
export function wantsInstall(search: string): boolean {
  return /[?&]instalar(=|&|$)/.test(search);
}
