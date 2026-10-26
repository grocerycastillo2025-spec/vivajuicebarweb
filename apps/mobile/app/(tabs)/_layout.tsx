import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ReactNode } from 'react';
import type { ColorValue } from 'react-native';

import { useBranding } from '../../src/state/branding-context';
import { strings } from '../../src/strings';

type IconName = keyof typeof Ionicons.glyphMap;

function tabIcon(name: IconName, focused: IconName) {
  return function TabIcon({
    color,
    size,
    focused: isFocused,
  }: {
    color: ColorValue;
    size: number;
    focused: boolean;
  }): ReactNode {
    return <Ionicons name={isFocused ? focused : name} size={size} color={color} />;
  };
}

export default function TabsLayout(): ReactNode {
  const { colors, features, loading } = useBranding();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        // react-navigation ya reserva el inset inferior de la barra de
        // sistema; no hay que sumarle padding a mano.
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: strings.tabs.home, tabBarIcon: tabIcon('home-outline', 'home') }}
      />
      <Tabs.Screen
        name="menu"
        options={{
          title: strings.tabs.menu,
          tabBarIcon: tabIcon('restaurant-outline', 'restaurant'),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{ title: strings.tabs.orders, tabBarIcon: tabIcon('receipt-outline', 'receipt') }}
      />
      <Tabs.Screen
        name="rewards"
        options={{
          title: strings.tabs.rewards,
          tabBarIcon: tabIcon('gift-outline', 'gift'),
          // `app_settings.features.loyalty` en false esconde la pestana.
          // `href: null` la saca de la barra Y de la navegacion, asi que
          // tampoco se llega a ella por enlace directo. Se aplica con un
          // spread porque `exactOptionalPropertyTypes` no admite
          // `href: undefined` como forma de "no pasar la prop".
          // Mientras carga la marca no se ensena: si luego resulta apagada,
          // la barra no salta de 5 a 4 pestanas al abrir.
          ...(features.loyalty && !loading ? {} : { href: null }),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: strings.tabs.profile, tabBarIcon: tabIcon('person-outline', 'person') }}
      />
    </Tabs>
  );
}
