/** Sector packs a company can turn on. The core (tasks, fleet, customers, billing) is always on. */
export const PACKS = [
  { code: 'delivery', sector: 1, label: 'توصيل الطلبات والمندوبين' },
  { code: 'freight', sector: 2, label: 'الشحن والنقل البري' },
  { code: 'coldchain', sector: 3, label: 'التوزيع الغذائي والتبريد' },
  { code: 'courier', sector: 4, label: 'البريد والشحن السريع' },
  { code: 'warehouse', sector: 8, label: 'المستودعات والتخزين' },
  { code: 'ecommerce', sector: 9, label: 'شحن التجارة الإلكترونية' },
  { code: 'shuttle', sector: 11, label: 'نقل الموظفين' },
  { code: 'staffing', sector: 14, label: 'توفير السائقين والمندوبين' },
  { code: 'equipment', sector: 16, label: 'تأجير المعدات الثقيلة' },
  { code: 'rental', sector: 17, label: 'تأجير السيارات' },
  { code: 'concrete', sector: 20, label: 'الخرسانة الجاهزة' },
  { code: 'internal', sector: 21, label: 'أسطول الشركة الداخلي' },
  { code: 'distribution', sector: 29, label: 'التوزيع للمصانع والمطاعم والتجزئة' },
] as const;
export type PackCode = (typeof PACKS)[number]['code'];
export const PACK_CODES: readonly string[] = PACKS.map((p) => p.code);

/** "delivery@1" → "delivery" when it is a known pack; generic task types return null (always allowed). */
export function packOf(sectorPack: string): string | null {
  const code = sectorPack.split('@')[0];
  return PACK_CODES.includes(code) ? code : null;
}

/** Validates a list from a client: known codes, no duplicates. Returns null when invalid. */
export function parsePacks(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !PACK_CODES.includes(x))) return null;
  return PACK_CODES.filter((c) => v.includes(c));
}
