/**
 * Sonido, vibración, avisos del navegador y pantalla encendida.
 *
 * Todo esto existe solo en web (la app es una PWA). Fuera de web, o si el
 * navegador no lo permite, cada función simplemente no hace nada: el
 * pedido igual aparece en pantalla.
 *
 * Reglas de los navegadores que hay que respetar:
 *  - El sonido solo arranca después de que alguien TOCÓ la página una vez
 *    (por eso el panel enseña "Toca para activar el sonido").
 *  - La vibración funciona en Android (Chrome); iPhone no la permite.
 *  - Los avisos del navegador piden permiso una vez.
 */

import { Platform } from 'react-native';

import { appPublicUrl } from '../admin/qr';
import { STRONG_VIBRATION, volumeGain, type AlarmSound, type AlarmVolume } from '../domain/alerts';

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined';

// ---------------------------------------------------------------------
// Sonido
// ---------------------------------------------------------------------
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (!isWeb) return null;
  if (ctx !== null) return ctx;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  ctx = new Ctor();
  return ctx;
}

/** ¿El navegador todavía no deja sonar? (falta un toque en la página) */
export function soundLocked(): boolean {
  const c = audio();
  return c !== null && c.state !== 'running';
}

/** Llamar dentro de un toque: desbloquea el sonido para el resto de la visita. */
export async function unlockSound(): Promise<boolean> {
  const c = audio();
  if (c === null) return false;
  try {
    await c.resume();
    // Un silencio de 1 ms "calienta" el audio en Safari.
    const osc = c.createOscillator();
    const gain = c.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.001);
  } catch {
    return false;
  }
  return c.state === 'running';
}

/** Desbloquea con el primer toque en cualquier parte de la página. */
export function unlockOnFirstTouch(onUnlocked: () => void): () => void {
  if (!isWeb) return () => undefined;
  const handler = (): void => {
    void unlockSound().then((ok) => {
      if (ok) onUnlocked();
    });
  };
  window.addEventListener('pointerdown', handler, { once: false });
  window.addEventListener('keydown', handler, { once: false });
  return () => {
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
  };
}

type Note = { readonly f: number; readonly at: number; readonly dur: number; readonly type?: OscillatorType };

// Tonos hechos con el propio navegador (sin archivos que descargar).
const PATTERNS: Record<Exclude<AlarmSound, 'propio'>, readonly Note[]> = {
  campana: [
    { f: 1046, at: 0, dur: 0.6 },
    { f: 1318, at: 0.25, dur: 0.6 },
    { f: 1568, at: 0.5, dur: 0.9 },
  ],
  timbre: [
    { f: 880, at: 0, dur: 0.35, type: 'square' },
    { f: 660, at: 0.4, dur: 0.5, type: 'square' },
    { f: 880, at: 1.0, dur: 0.35, type: 'square' },
    { f: 660, at: 1.4, dur: 0.5, type: 'square' },
  ],
  alarma: [
    { f: 988, at: 0, dur: 0.18, type: 'sawtooth' },
    { f: 1318, at: 0.2, dur: 0.18, type: 'sawtooth' },
    { f: 988, at: 0.4, dur: 0.18, type: 'sawtooth' },
    { f: 1318, at: 0.6, dur: 0.18, type: 'sawtooth' },
    { f: 988, at: 0.8, dur: 0.18, type: 'sawtooth' },
    { f: 1318, at: 1.0, dur: 0.3, type: 'sawtooth' },
  ],
};

let customAudio: HTMLAudioElement | null = null;

export async function playSound(sound: AlarmSound, volume: AlarmVolume, customUrl: string | null): Promise<void> {
  if (!isWeb) return;
  const gainValue = volumeGain(volume);
  if (sound === 'propio' && customUrl !== null) {
    try {
      if (customAudio === null || customAudio.src !== customUrl) customAudio = new Audio(customUrl);
      customAudio.volume = gainValue;
      customAudio.currentTime = 0;
      await customAudio.play();
      return;
    } catch {
      // Si el archivo no suena, cae al tono de alarma.
    }
  }
  const c = audio();
  if (c === null) return;
  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {
      return;
    }
  }
  const notes = PATTERNS[sound === 'propio' ? 'alarma' : sound];
  const t0 = c.currentTime + 0.02;
  for (const n of notes) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.value = n.f;
    osc.connect(gain).connect(c.destination);
    const start = t0 + n.at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.5 * gainValue), start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
    osc.start(start);
    osc.stop(start + n.dur + 0.05);
  }
}

// ---------------------------------------------------------------------
// Vibración
// ---------------------------------------------------------------------
export function canVibrate(): boolean {
  return isWeb && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function vibrate(pattern: readonly number[] = STRONG_VIBRATION): void {
  if (!canVibrate()) return;
  try {
    navigator.vibrate([...pattern]);
  } catch {
    // ignorado
  }
}

// ---------------------------------------------------------------------
// Avisos del navegador
// ---------------------------------------------------------------------
export function notificationsSupported(): boolean {
  return isWeb && typeof Notification !== 'undefined';
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function askNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Aviso del sistema (aunque la pestaña esté atrás). Usa el service worker
 * cuando existe, que en Android es lo que permite vibrar y que el aviso
 * se quede hasta que lo toquen.
 */
export async function systemNotice(input: {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly url?: string;
  readonly insist?: boolean;
}): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const options = {
    body: input.body,
    tag: input.tag,
    renotify: true,
    requireInteraction: input.insist === true,
    vibrate: [...STRONG_VIBRATION],
    icon: `${appPublicUrl()}/icons/icon-192.png`,
    badge: `${appPublicUrl()}/icons/icon-192.png`,
    data: { url: input.url ?? window.location.href },
  } as NotificationOptions;
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg !== undefined && reg !== null) {
      await reg.showNotification(input.title, options);
      return;
    }
  } catch {
    // sin service worker: aviso simple
  }
  try {
    new Notification(input.title, options);
  } catch {
    // ignorado
  }
}

// ---------------------------------------------------------------------
// Título de la pestaña parpadeando
// ---------------------------------------------------------------------
let titleTimer: ReturnType<typeof setInterval> | null = null;
let originalTitle: string | null = null;

export function flashTitle(text: string | null): void {
  if (!isWeb) return;
  if (text === null) {
    if (titleTimer !== null) clearInterval(titleTimer);
    titleTimer = null;
    if (originalTitle !== null) document.title = originalTitle;
    originalTitle = null;
    return;
  }
  if (originalTitle === null) originalTitle = document.title;
  if (titleTimer !== null) clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? text : (originalTitle ?? '');
  }, 1000);
}

// ---------------------------------------------------------------------
// Pantalla encendida
// ---------------------------------------------------------------------
type WakeLockSentinelLike = { release: () => Promise<void> };
let wake: WakeLockSentinelLike | null = null;

export function wakeLockSupported(): boolean {
  return isWeb && typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export async function keepScreenOn(on: boolean): Promise<void> {
  if (!wakeLockSupported()) return;
  try {
    if (on && wake === null) {
      wake = await (navigator as unknown as { wakeLock: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } })
        .wakeLock.request('screen');
    } else if (!on && wake !== null) {
      await wake.release();
      wake = null;
    }
  } catch {
    wake = null;
  }
}

/** El candado de pantalla se suelta al cambiar de pestaña: se vuelve a pedir. */
export function rewakeOnVisible(getOn: () => boolean): () => void {
  if (!isWeb) return () => undefined;
  const handler = (): void => {
    if (document.visibilityState === 'visible' && getOn()) {
      wake = null;
      void keepScreenOn(true);
    }
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

// ---------------------------------------------------------------------
// Sonido propio (se guarda en este navegador)
// ---------------------------------------------------------------------
const CUSTOM_KEY = 'juicebar.alarma.sonido.v1';
export const MAX_CUSTOM_BYTES = 1_500_000;

export function loadCustomSound(): string | null {
  try {
    return globalThis.localStorage?.getItem(CUSTOM_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveCustomSound(dataUrl: string | null): boolean {
  try {
    if (dataUrl === null) globalThis.localStorage?.removeItem(CUSTOM_KEY);
    else globalThis.localStorage?.setItem(CUSTOM_KEY, dataUrl);
    return true;
  } catch {
    return false;
  }
}

/** Abre el selector de archivos y devuelve el audio como data URL. */
export function pickSoundFile(): Promise<{ dataUrl: string } | { error: 'too_big' | 'not_audio' } | null> {
  if (!isWeb) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file === undefined) return resolve(null);
      if (!file.type.startsWith('audio/')) return resolve({ error: 'not_audio' });
      if (file.size > MAX_CUSTOM_BYTES) return resolve({ error: 'too_big' });
      const reader = new FileReader();
      reader.onload = () => resolve({ dataUrl: String(reader.result) });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    document.body.appendChild(input);
    input.click();
  });
}
