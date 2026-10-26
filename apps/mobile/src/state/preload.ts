/** Precarga de imágenes en el APK (caché de expo-image). */
import { Image } from 'expo-image';

export function preloadImages(urls: readonly string[]): void {
  if (urls.length === 0) return;
  void Image.prefetch([...urls]).catch(() => false);
}
