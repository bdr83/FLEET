export const PERMISSIONS = [
  'org:read', 'org:write',
  'members:read', 'members:write',
  'tasks:read', 'tasks:write', 'tasks:assign', 'tasks:read_own', 'tasks:update_own',
  'fleet:read', 'fleet:write',
  'customers:read', 'customers:write',
  'billing:read', 'billing:write',
  'reports:read', 'shift:own', 'portal:own',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function hasPermission(granted: string[], needed: Permission): boolean {
  return granted.includes('*') || granted.includes(needed);
}
