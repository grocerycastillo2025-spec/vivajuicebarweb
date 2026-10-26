/**
 * Video de historia en el APK: todavia no hay reproductor nativo (haria
 * falta `expo-video`, una dependencia nativa). Se salta al terminar la
 * cuenta de una imagen y se avisa.
 */

import { useEffect, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { strings } from '../strings';

export interface StoryVideoProps {
  readonly uri: string;
  readonly paused: boolean;
  readonly onProgress: (fraction: number) => void;
  readonly onEnd: () => void;
}

export function StoryVideo({ onEnd }: StoryVideoProps): ReactNode {
  useEffect(() => {
    const id = setTimeout(onEnd, 3000);
    return () => clearTimeout(id);
  }, [onEnd]);
  return (
    <View style={styles.box}>
      <Text style={styles.text}>{strings.stories.videoWebOnly}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  text: { color: '#fff', textAlign: 'center', fontSize: 16 },
});
