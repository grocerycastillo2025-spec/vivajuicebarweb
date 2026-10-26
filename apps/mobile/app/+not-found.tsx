import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';

import { Screen } from '../src/components/Screen';
import { Button, EmptyState } from '../src/components/ui';
import { strings } from '../src/strings';

export default function NotFoundScreen(): ReactNode {
  const router = useRouter();

  return (
    <Screen scroll={false}>
      <EmptyState
        title={strings.notFound.title}
        body={strings.notFound.body}
        action={<Button label={strings.notFound.goHome} onPress={() => router.replace('/')} />}
      />
    </Screen>
  );
}
