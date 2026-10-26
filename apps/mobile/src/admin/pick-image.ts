/**
 * Elegir una foto desde el panel.
 *
 * Solo en web, a proposito: el panel se usa desde la app web y en el
 * telefono se puede abrir igual en el navegador. Meter `expo-image-picker`
 * seria una dependencia NATIVA nueva, y eso obliga a recompilar el APK y
 * a subir el `runtimeVersion` (docs/RUNTIME-Y-UPDATES.md) solo para algo
 * que el navegador ya hace.
 *
 * La foto se reduce en el navegador antes de subirla: una foto de
 * telefono pesa 4-8 MB y el bucket admite 5 MB; a 1200 px en JPEG pesa
 * ~200 KB y se ve igual en la app.
 */

import { Platform } from 'react-native';

export interface PickedImage {
  readonly blob: Blob;
  readonly extension: string;
  readonly previewUrl: string;
}

export const canPickImages = Platform.OS === 'web' && typeof document !== 'undefined';

function chooseFile(accept = 'image/png,image/jpeg,image/webp'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    // Si el usuario cierra el dialogo no llega `change`; la promesa se
    // queda pendiente y se recoge con el componente. No bloquea nada.
    document.body.appendChild(input);
    input.click();
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo leer la imagen'));
    image.src = url;
  });
}

async function shrink(file: File, maxSide: number, keepAlpha: boolean): Promise<PickedImage> {
  const image = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('El navegador no pudo procesar la imagen');
  context.drawImage(image, 0, 0, width, height);

  const type = keepAlpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  if (blob === null) throw new Error('El navegador no pudo procesar la imagen');

  return {
    blob,
    extension: keepAlpha ? 'png' : 'jpg',
    previewUrl: URL.createObjectURL(blob),
  };
}

/** Foto de producto: JPEG, lado mayor 1200 px. */
export async function pickProductPhoto(): Promise<PickedImage | null> {
  if (!canPickImages) return null;
  const file = await chooseFile();
  if (file === null) return null;
  return shrink(file, 1200, false);
}

/** Logo: PNG para conservar la transparencia, lado mayor 800 px. */
export async function pickLogo(): Promise<PickedImage | null> {
  if (!canPickImages) return null;
  const file = await chooseFile();
  if (file === null) return null;
  return shrink(file, 800, true);
}

export interface PickedStoryMedia extends PickedImage {
  readonly mediaType: 'image' | 'video';
}

/**
 * Historia: foto (se reduce a 1280 px, vertical como Instagram) o video
 * tal cual (mp4, webm o mov hasta 50 MB). Lanza con un mensaje claro si
 * el archivo no sirve.
 */
export async function pickStoryMedia(): Promise<PickedStoryMedia | null> {
  if (!canPickImages) return null;
  const file = await chooseFile('image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime');
  if (file === null) return null;

  if (file.type.startsWith('image/')) {
    const image = await shrink(file, 1280, false);
    return { ...image, mediaType: 'image' };
  }
  const extension = file.type === 'video/webm' ? 'webm' : file.type === 'video/quicktime' ? 'mov' : 'mp4';
  if (!/^video\/(mp4|webm|quicktime)$/.test(file.type)) {
    throw new Error('Formato no admitido. Usa una foto (JPG, PNG) o un video MP4, WEBM o MOV.');
  }
  if (file.size > 50 * 1024 * 1024) {
    throw new Error('El video pesa más de 50 MB. Recórtalo o grábalo en menor calidad.');
  }
  return { blob: file, extension, previewUrl: URL.createObjectURL(file), mediaType: 'video' };
}
