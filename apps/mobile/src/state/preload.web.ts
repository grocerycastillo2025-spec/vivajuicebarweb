/** Precarga de imágenes en el navegador: quedan en su caché. */
const done = new Set<string>();

export function preloadImages(urls: readonly string[]): void {
  for (const url of urls) {
    if (done.has(url)) continue;
    done.add(url);
    const img = new window.Image();
    img.decoding = 'async';
    img.src = url;
  }
}
