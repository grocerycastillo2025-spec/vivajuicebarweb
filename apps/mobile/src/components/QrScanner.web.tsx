/**
 * Escaner de QR en el navegador: camara trasera + jsQR.
 *
 * Por que dentro de la app y no solo con la camara del telefono: en
 * iPhone, la app instalada en la pantalla de inicio tiene su PROPIA sesion,
 * separada de Safari. Escanear con la camara abre Safari, donde el cliente
 * no ha iniciado sesion. Escaneando desde aqui, la visita se suma en la
 * sesion de la app.
 *
 * `getUserMedia` solo funciona en HTTPS (o localhost). GitHub Pages y un
 * dominio propio con certificado lo cumplen.
 */

import jsQR from 'jsqr';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { strings } from '../strings';

export interface QrScannerProps {
  /** Devuelve `true` si el texto sirvio y hay que dejar de escanear. */
  readonly onResult: (text: string) => boolean;
}

type Status = 'starting' | 'scanning' | 'denied' | 'unavailable';

export function QrScanner({ onResult }: QrScannerProps): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const [status, setStatus] = useState<Status>('starting');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const tick = (): void => {
      if (stopped) return;
      const video = videoRef.current;
      if (video !== null && context !== null && video.readyState >= 2 && video.videoWidth > 0) {
        // Se decodifica a ~640 px de ancho: suficiente para un QR de
        // mostrador y cuatro veces menos trabajo que a resolucion completa.
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        if (found !== null && found.data !== '' && onResultRef.current(found.data)) {
          stop();
          return;
        }
      }
      timer = setTimeout(tick, 200);
    };

    const stop = (): void => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };

    if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
      setStatus('unavailable');
      return undefined;
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((media) => {
        if (stopped) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        const video = videoRef.current;
        if (video !== null) {
          video.srcObject = media;
          void video.play().catch(() => undefined);
        }
        setStatus('scanning');
        tick();
      })
      .catch((cause: unknown) => {
        const name = cause instanceof DOMException ? cause.name : '';
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
      });

    return stop;
  }, []);

  if (status === 'denied' || status === 'unavailable') {
    return (
      <View style={styles.message}>
        <Text style={styles.messageText}>
          {status === 'denied' ? strings.scanner.denied : strings.scanner.unavailable}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.frame}>
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      <View style={styles.reticle} pointerEvents="none" />
      {status === 'starting' ? <Text style={styles.overlayText}>{strings.scanner.starting}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: {
    position: 'absolute',
    width: '62%',
    aspectRatio: 1,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
  },
  overlayText: { position: 'absolute', color: '#fff', fontWeight: '700' },
  message: { padding: 16, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.05)' },
  messageText: { fontSize: 15, lineHeight: 22, color: '#333' },
});
