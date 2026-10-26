/**
 * Quien esta usando el panel y sobre que sucursal.
 *
 * Lo resuelve `app/admin/_layout.tsx` una vez y lo comparte con todas las
 * pantallas del panel. No es una barrera de seguridad —esa es la RLS—,
 * es para no ensenar botones que la base va a rechazar.
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { MemberRole } from '../api/admin';
import type { StoreRow } from '../api/types';

export interface AdminContextValue {
  readonly restaurantId: string;
  readonly role: MemberRole;
  readonly isOwner: boolean;
  readonly store: StoreRow;
  /** Vuelve a leer la sucursal (despues de editarla). */
  readonly reloadStore: () => void;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({
  value,
  children,
}: {
  readonly value: AdminContextValue;
  readonly children: ReactNode;
}): ReactNode {
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (value === null) throw new Error('useAdmin() fuera de app/admin/_layout.tsx');
  return value;
}
