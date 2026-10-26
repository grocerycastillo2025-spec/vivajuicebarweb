/** Video de una historia en el navegador. Avisa del progreso y del final. */

import { useEffect, useRef, type ReactNode } from 'react';

export interface StoryVideoProps {
  readonly uri: string;
  readonly paused: boolean;
  readonly onProgress: (fraction: number) => void;
  readonly onEnd: () => void;
}

export function StoryVideo({ uri, paused, onProgress, onEnd }: StoryVideoProps): ReactNode {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (video === null) return;
    if (paused) video.pause();
    else void video.play().catch(() => undefined);
  }, [paused, uri]);

  return (
    <video
      key={uri}
      ref={ref}
      src={uri}
      autoPlay
      playsInline
      // Empieza en silencio porque los navegadores no dejan reproducir
      // con sonido sin un toque previo; el control de volumen queda en el
      // telefono.
      muted
      onTimeUpdate={(event) => {
        const v = event.currentTarget;
        if (v.duration > 0) onProgress(v.currentTime / v.duration);
      }}
      onEnded={onEnd}
      onError={onEnd}
      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
    />
  );
}
