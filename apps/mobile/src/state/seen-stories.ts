/**
 * Historias que este telefono ya vio. Se guarda en el dispositivo (no en
 * la cuenta): sirve para pintar el aro de color solo en lo nuevo.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { trimSeen } from '../domain/stories';

const KEY = 'viva.stories.seen.v1';
let seen: string[] | null = null;
const listeners = new Set<(ids: ReadonlySet<string>) => void>();

async function load(): Promise<string[]> {
  if (seen !== null) return seen;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    seen = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    seen = [];
  }
  return seen;
}

/** Lo visto en este teléfono, ya leído del almacenamiento. */
export async function loadSeenStories(): Promise<ReadonlySet<string>> {
  return new Set(await load());
}

export function markStorySeen(id: string): void {
  void load().then((current) => {
    if (current.includes(id)) return;
    seen = trimSeen([...current, id]);
    void AsyncStorage.setItem(KEY, JSON.stringify(seen)).catch(() => undefined);
    const snapshot = new Set(seen);
    listeners.forEach((fn) => fn(snapshot));
  });
}

export function useSeenStories(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set(seen ?? []));
  useEffect(() => {
    let alive = true;
    void load().then((current) => alive && setIds(new Set(current)));
    listeners.add(setIds);
    return () => {
      alive = false;
      listeners.delete(setIds);
    };
  }, []);
  return ids;
}
