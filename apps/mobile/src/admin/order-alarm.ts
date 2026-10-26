/**
 * La alarma de Pedidos: suena (y vibra, y avisa) al entrar un pedido y se
 * repite hasta que alguien lo pasa a "En preparación".
 *
 * La decisión de cuándo sonar está en src/domain/alerts.ts (probada); aquí
 * solo se conecta con el reloj, el navegador y lo que eligió este
 * dispositivo (se guarda en el navegador: cada tablet o teléfono elige su
 * sonido).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { newArrivals } from '../domain/admin';
import { parseAlarmSettings, shouldRing, waitingOrders, type AlarmSettings } from '../domain/alerts';
import {
  flashTitle,
  keepScreenOn,
  loadCustomSound,
  playSound,
  rewakeOnVisible,
  soundLocked,
  systemNotice,
  unlockOnFirstTouch,
  unlockSound,
  vibrate,
} from '../lib/alerts';
import { appPublicUrl } from './qr';
import { adminStrings } from './strings';

const KEY = 'juicebar.alarma.v1';

function readSettings(): AlarmSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return parseAlarmSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return parseAlarmSettings(null);
  }
}

export function useAlarmSettings(): [AlarmSettings, (next: AlarmSettings) => void] {
  const [settings, setSettings] = useState<AlarmSettings>(readSettings);
  const save = useCallback((next: AlarmSettings) => {
    setSettings(next);
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
    } catch {
      // modo privado: vale solo esta visita
    }
  }, []);
  return [settings, save];
}

export function ringOnce(settings: AlarmSettings): void {
  void playSound(settings.sound, settings.volume, settings.sound === 'propio' ? loadCustomSound() : null);
  if (settings.vibrate) vibrate();
}

export interface OrderAlarm {
  readonly waiting: number;
  readonly locked: boolean;
  readonly unlock: () => void;
  readonly snoozedUntil: number | null;
  readonly snooze: (minutes: number) => void;
}

export function useOrderAlarm<T extends { readonly id: string; readonly status: string }>(
  orders: readonly T[] | null,
  settings: AlarmSettings,
): OrderAlarm {
  const seen = useRef<Set<string> | null>(null);
  const lastRingAt = useRef<number | null>(null);
  const waitingRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(null);
  const snoozeRef = useRef<number | null>(null);
  snoozeRef.current = snoozedUntil;
  const [locked, setLocked] = useState<boolean>(() => soundLocked());

  const ring = useCallback((waiting: number) => {
    lastRingAt.current = Date.now();
    ringOnce(settingsRef.current);
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (settingsRef.current.notify && hidden) {
      void systemNotice({
        title: adminStrings.alarm.notifTitle(waiting),
        body: adminStrings.alarm.notifBody,
        tag: 'pedidos-nuevos',
        url: `${appPublicUrl()}/admin`,
        insist: true,
      });
    }
  }, []);

  // Llegó algo nuevo (no en la primera carga).
  useEffect(() => {
    if (orders === null) return;
    const arrived = newArrivals(seen.current, orders as never).length;
    seen.current = new Set(orders.map((o) => o.id));
    const waiting = waitingOrders(orders).length;
    waitingRef.current = waiting;
    if (
      shouldRing({
        now: Date.now(),
        arrived,
        waiting,
        lastRingAt: lastRingAt.current,
        repeatSeconds: settingsRef.current.repeatSeconds,
        snoozedUntil: snoozeRef.current,
      }) &&
      arrived > 0
    ) {
      ring(Math.max(waiting, arrived));
    }
    flashTitle(waiting > 0 ? adminStrings.alarm.titleFlash(waiting) : null);
  }, [orders, ring]);

  // Recordatorio: se repite mientras haya pedidos sin atender.
  useEffect(() => {
    const id = setInterval(() => {
      const waiting = waitingRef.current;
      if (
        shouldRing({
          now: Date.now(),
          arrived: 0,
          waiting,
          lastRingAt: lastRingAt.current,
          repeatSeconds: settingsRef.current.repeatSeconds,
          snoozedUntil: snoozeRef.current,
        })
      ) {
        ring(waiting);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [ring]);

  // Sonido bloqueado hasta el primer toque.
  useEffect(() => unlockOnFirstTouch(() => setLocked(false)), []);

  // Pantalla encendida.
  useEffect(() => {
    void keepScreenOn(settings.keepAwake);
    const stop = rewakeOnVisible(() => settingsRef.current.keepAwake);
    return () => {
      stop();
    };
  }, [settings.keepAwake]);

  // Al salir de Pedidos: título normal y la pantalla puede apagarse.
  useEffect(
    () => () => {
      flashTitle(null);
      void keepScreenOn(false);
    },
    [],
  );

  const unlock = useCallback(() => {
    void unlockSound().then((ok) => {
      setLocked(!ok);
      if (ok) ringOnce(settingsRef.current);
    });
  }, []);

  const snooze = useCallback((minutes: number) => {
    setSnoozedUntil(minutes <= 0 ? null : Date.now() + minutes * 60_000);
  }, []);

  return { waiting: orders === null ? 0 : waitingOrders(orders).length, locked, unlock, snoozedUntil, snooze };
}
