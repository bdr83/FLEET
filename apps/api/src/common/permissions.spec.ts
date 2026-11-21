import { hasPermission } from './permissions';

describe('hasPermission', () => {
  it('owner wildcard', () => expect(hasPermission(['*'], 'billing:write')).toBe(true));
  it('exact match', () => expect(hasPermission(['tasks:read'], 'tasks:read')).toBe(true));
  it('no implicit write from read', () => expect(hasPermission(['tasks:read'], 'tasks:write')).toBe(false));
});
