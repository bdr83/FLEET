/**
 * Normalizes a phone number to E.164. Kuwait first: 8-digit local numbers get +965.
 * Accepts +9715..., +966... etc. for the GCC rollout. [تحقق محلي] for exact numbering plans.
 */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  let s = input.replace(/[٠-٩]/g, (d) => String(arabicIndic.indexOf(d))).replace(/[\s\-()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^[0-9]{8}$/.test(s)) s = '+965' + s;
  if (!/^\+[1-9][0-9]{7,14}$/.test(s)) return null;
  if (s.startsWith('+965') && !/^\+965[124569][0-9]{7}$/.test(s)) return null;
  return s;
}
