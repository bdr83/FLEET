import { BadRequestException } from '@nestjs/common';
import { addQty, checkDelivered, Item, loadList, qty, qtyMap, reconcile, valueFils } from './distribution';

const milk: Item = { sku: 'MLK-1L', name: 'حليب 1 لتر', qty: 24, price: '0.350' };
const bread: Item = { sku: 'BRD', name: 'خبز', qty: 10.5, price: '0.125' };

describe('distribution helpers', () => {
  it('validates quantities with up to 3 decimals', () => {
    expect(qty(2.5, 'q')).toBe(2.5);
    expect(qty('3', 'q')).toBe(3);
    expect(() => qty(0, 'q')).toThrow(BadRequestException);
    expect(qty(0, 'q', { zero: true })).toBe(0);
    expect(() => qty(1.2345, 'q')).toThrow(BadRequestException);
    expect(() => qty(-1, 'q')).toThrow(BadRequestException);
    expect(addQty(0.1, 0.2)).toBe(0.3);
    expect(qtyMap({ A: 2, B: 0 }, 'd')).toEqual({ A: 2 }); // zeros dropped
    expect(() => qtyMap({ 'bad sku': 1 }, 'd')).toThrow(BadRequestException);
    expect(() => qtyMap([1], 'd')).toThrow(BadRequestException);
  });
  it('sums the load list across stops', () => {
    expect(loadList([{ items: [milk, bread] }, { items: [{ ...milk, qty: 12 }] }])).toEqual([
      { sku: 'BRD', name: 'خبز', qty: 10.5 }, { sku: 'MLK-1L', name: 'حليب 1 لتر', qty: 36 }]);
  });
  it('values quantities in fils at the stop prices', () => {
    expect(valueFils({ 'MLK-1L': 20, BRD: 10 }, [milk, bread])).toBe(7000 + 1250);
    expect(valueFils({ OTHER: 5 }, [milk])).toBe(0);
    expect(valueFils({ BRD: 0.333 }, [bread])).toBe(42); // 41.625 → 42
  });
  it('delivers only what was planned, never more', () => {
    expect(checkDelivered([milk], { 'MLK-1L': 24 })).toBeNull();
    expect(checkDelivered([milk], { 'MLK-1L': 25 })).toBe('quantity_exceeds_plan');
    expect(checkDelivered([milk], { BRD: 1 })).toBe('item_not_planned');
  });
  it('reconciles loaded, delivered, returned and what comes back to the warehouse', () => {
    const r = reconcile([
      { items: [milk, bread], delivered: { 'MLK-1L': 20, BRD: 10.5 }, returned: { 'MLK-1L': 2 } },
      { items: [{ ...milk, qty: 12 }], delivered: null, returned: null },  // shop closed
    ]);
    expect(r).toEqual([
      { sku: 'BRD', name: 'خبز', loaded: 10.5, delivered: 10.5, returned: 0, back: 0 },
      { sku: 'MLK-1L', name: 'حليب 1 لتر', loaded: 36, delivered: 20, returned: 2, back: 18 },
    ]);
  });
});
