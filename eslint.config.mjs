// @ts-check
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/.turbo/**',
      // Generado por `pnpm db:types`, no se edita a mano.
      'packages/shared-types/src/database.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Permite `_unused` para parámetros que la interfaz exige pero no se usan.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // El dinero va en centavos enteros: prohibido usar `any` en dominio.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // La app móvil es React: las reglas de hooks atrapan estados obsoletos
  // y efectos mal declarados, que en una pantalla de menú se traducen en
  // precios que no se refrescan.
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
