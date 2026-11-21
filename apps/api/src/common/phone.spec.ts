import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it.each([
    ['55551234', '+96555551234'],
    ['+965 9999 1234', '+96599991234'],
    ['0096566661234', '+96566661234'],
    ['٩٩٩٩١٢٣٤', '+96599991234'],
    ['+966501234567', '+966501234567'],
  ])('%s -> %s', (i, o) => expect(normalizePhone(i)).toBe(o));
  it.each(['123', '+96512', 'abc', '+96533331234', ''])('rejects %s', (i) => expect(normalizePhone(i)).toBeNull());
});
