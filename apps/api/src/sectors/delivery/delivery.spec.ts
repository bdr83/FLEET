import { addressLine, normalizeAttributes, pickDriver } from './delivery';

describe('delivery pack helpers', () => {
  it('normalises a Kuwaiti address, recipient phone and money, and keeps unknown keys', () => {
    const r = normalizeAttributes({
      dropoff: { area: 'السالمية', block: '5', street: '10', house: '12', lat: 29.33, lng: 48.07 },
      recipient: { name: 'أحمد', phone: '50000001' }, cod_amount: 7.5, delivery_fee: '1.250', tip: '', custom: 1,
    })!;
    expect(r.address).toBe('السالمية، ق 5، ش 10، م 12');
    expect(r.recipient).toEqual({ name: 'أحمد', phone: '+96550000001' });
    expect(r.cod_amount).toBe('7.5');
    expect(r.delivery_fee).toBe('1.250');
    expect(r).not.toHaveProperty('tip');
    expect(r.custom).toBe(1);
  });
  it('keeps an explicit address line and rejects bad input', () => {
    expect(normalizeAttributes({ address: 'نص', dropoff: { area: 'حولي' } })!.address).toBe('نص');
    expect(() => normalizeAttributes({ recipient: { phone: '123' } })).toThrow();
    expect(() => normalizeAttributes({ dropoff: { lat: 100, lng: 1 } })).toThrow();
    expect(() => normalizeAttributes({ cod_amount: '-1' })).toThrow();
    expect(() => normalizeAttributes({ dropoff: 'x' })).toThrow();
  });
  it('addressLine is empty for an empty address', () => {
    expect(addressLine({})).toBeUndefined();
    expect(addressLine(undefined)).toBeUndefined();
  });
  it('picks the nearest driver within the radius and under the cap', () => {
    const s = { max_open_per_driver: 2, auto_assign_radius_km: 15 };
    const near = { worker_id: 'near', asset_id: null, lat: 29.335, lng: 48.075, open_tasks: 1 };
    const nearBusy = { worker_id: 'busy', asset_id: null, lat: 29.331, lng: 48.071, open_tasks: 2 };
    const far = { worker_id: 'far', asset_id: null, lat: 29.0, lng: 48.1, open_tasks: 0 };
    const p = { lat: 29.33, lng: 48.07 };
    expect(pickDriver(p, [far, nearBusy, near], s)?.worker_id).toBe('near');
    expect(pickDriver(p, [far, nearBusy], s)).toBeNull();
    expect(pickDriver(null, [near, far], s)?.worker_id).toBe('far'); // no point: lightest load
  });
});
