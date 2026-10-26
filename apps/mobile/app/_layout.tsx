import { Stack } from 'expo-router';

import { OrderWatcher } from '../src/components/OrderWatcher';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { configureMoney } from '../src/domain/money';
import { readLocaleConfig } from '../src/env';
import { initLanguage, onLanguageChange, type Lang } from '../src/i18n';
import { BrandingProvider, useColors } from '../src/state/branding-context';
import { CartProvider } from '../src/state/cart-context';
import { PushProvider } from '../src/state/push-context';
import { SessionProvider } from '../src/state/session-context';
import { StoreProvider } from '../src/state/store-context';

// Moneda del negocio e idioma de quien usa la app, antes de pintar el
// primer precio o el primer texto.
const localeConfig = readLocaleConfig();
configureMoney(localeConfig.currency, localeConfig.locale);
const initialLang = initLanguage();

/**
 * Al cambiar de idioma se vuelve a montar el stack de pantallas: así cada
 * pantalla relee sus textos y vuelve a pedir el menú en el idioma nuevo.
 * Los providers (sesión, carrito) quedan arriba y no se pierden. En la web
 * la ruta sale de la URL, así que la persona se queda en la misma pantalla.
 */
function useLanguageKey(): Lang {
  const [lang, setLang] = useState<Lang>(initialLang);
  useEffect(() => onLanguageChange(setLang), []);
  return lang;
}

/**
 * El stack va en su propio componente porque necesita los colores de la
 * marca, y esos solo existen dentro de <BrandingProvider>.
 */
function RootStack(): ReactNode {
  const colors = useColors();
  const lang = useLanguageKey();

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        key={lang}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="item/[id]" options={{ presentation: 'card' }} />
        <Stack.Screen name="cart" options={{ presentation: 'modal' }} />
        <Stack.Screen name="store-picker" options={{ presentation: 'modal' }} />
        <Stack.Screen name="checkout" options={{ presentation: 'card' }} />
        <Stack.Screen name="pay/[id]" options={{ presentation: 'card' }} />
        <Stack.Screen name="order/[id]" options={{ presentation: 'card' }} />
      </Stack>
      <OrderWatcher />
    </>
  );
}

export default function RootLayout(): ReactNode {
  return (
    // SafeAreaProvider es obligatorio: Android 16 dibuja siempre
    // edge-to-edge y todas las pantallas leen los insets de aqui.
    //
    // Orden de los providers: branding y sucursales no dependen de nadie;
    // el carrito si depende de la sucursal elegida, asi que va dentro.
    <SafeAreaProvider>
      <BrandingProvider>
        <SessionProvider>
          <StoreProvider>
            <CartProvider>
              {/* Depende de la sesion: el token se guarda contra el
                  usuario, y al cerrar sesion se da de baja. */}
              <PushProvider>
                <RootStack />
              </PushProvider>
            </CartProvider>
          </StoreProvider>
        </SessionProvider>
      </BrandingProvider>
    </SafeAreaProvider>
  );
}
