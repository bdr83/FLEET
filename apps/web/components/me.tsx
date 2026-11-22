'use client';
import { createContext, useContext } from 'react';

export interface Me {
  user_id: string; phone: string | null; email?: string | null; display_name: string | null;
  tenant_id: string; tenant_name: string | null; tenant_status: string | null;
  role: string; permissions: string[];
  /** Sector packs the company turned on (delivery, staffing, concrete, internal, distribution). */
  packs?: string[];
  scope: { legal_entity_ids: string[]; branch_ids: string[] };
  legal_entities: { id: string; name: string; country: string; currency: string; timezone: string }[];
}
export const MeContext = createContext<Me | null>(null);
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside the app shell');
  return me;
}
export function hasPack(me: Me, pack: string) {
  return !me.packs || me.packs.includes(pack);
}
export function can(me: Me, perm: string) {
  return me.permissions.includes('*') || me.permissions.includes(perm);
}
