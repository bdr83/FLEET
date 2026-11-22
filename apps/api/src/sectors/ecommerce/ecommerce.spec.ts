import { ecomStatus, newApiKey, parseApiKey, parseItems, secretMatches } from './ecommerce';

describe('e-commerce pack rules', () => {
  it('API keys: shown once, found by prefix, checked by hash', () => {
    const k = newApiKey();
    const p = parseApiKey(k.key)!;
    expect(p.prefix).toBe(k.prefix);
    expect(secretMatches(p.secret, k.hash)).toBe(true);
    expect(secretMatches(p.secret.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), k.hash)).toBe(false);
    expect(parseApiKey('Bearer xyz')).toBeNull();
    expect(parseApiKey(undefined)).toBeNull();
  });

  it('store-facing status', () => {
    const s = (o: Partial<Parameters<typeof ecomStatus>[0]>) => ecomStatus({ canceled_at: null, wh_status: null, task_status: null, rto_at: null, rto_done_at: null, ...o });
    expect(s({ wh_status: 'open' })).toBe('processing');
    expect(s({ wh_status: 'picked' })).toBe('ready_to_ship');
    expect(s({ wh_status: 'shipped', task_status: 'ready' })).toBe('confirmed');
    expect(s({ task_status: 'in_progress' })).toBe('out_for_delivery');
    expect(s({ task_status: 'completed' })).toBe('delivered');
    expect(s({ task_status: 'failed' })).toBe('failed');
    expect(s({ task_status: 'failed', rto_at: 'x' })).toBe('returning_to_store');
    expect(s({ task_status: 'failed', rto_at: 'x', rto_done_at: 'y' })).toBe('returned_to_store');
    expect(s({ task_status: 'canceled' })).toBe('canceled');
  });

  it('order lines', () => {
    expect(parseItems([{ sku: 'TSH-M', qty: 2 }, { name: 'كوب', qty: '1' }])).toEqual([{ sku: 'TSH-M', name: 'TSH-M', qty: 2 }, { name: 'كوب', qty: 1 }]);
    expect(parseItems([{ qty: 1 }])).toMatch(/name or sku/);
    expect(parseItems([{ name: 'x', qty: 0 }])).toMatch(/qty/);
    expect(parseItems(undefined)).toEqual([]);
  });
});
