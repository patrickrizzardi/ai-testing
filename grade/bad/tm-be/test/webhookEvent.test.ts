// Tier: High (untrusted input validator). Unit tests of body validation.
import { describe, expect, test } from 'bun:test';
import { canonicalJson, parseJsonObject } from '../src/json.ts';
import { validateEvent } from '../src/webhookEvent.ts';

const split = (merchantId: string, weightBps: number) => ({ merchantId, weightBps });
const authorizedData = { paymentId: 'pay_1', amountMinor: 100, currency: 'USD', splits: [split('m_a', 10000)] };
const envelope = (overrides: Record<string, unknown>) => ({
  id: 'evt_1',
  type: 'payment.authorized',
  createdAt: '2023-11-14T22:13:20Z',
  data: authorizedData,
  ...overrides,
});
const dataWith = (overrides: Record<string, unknown>) => envelope({ data: { ...authorizedData, ...overrides } });

function verdict(body: unknown): string {
  const parsed = parseJsonObject(JSON.stringify(body));
  if (!parsed.ok) return parsed.error.code;
  const event = validateEvent(parsed.value);
  return event.ok ? 'valid' : event.error.code;
}

describe('validateEvent', () => {
  test('accepts one valid event of every type and ignores unknown fields', () => {
    // Bug caught: rejecting extra fields, mis-shaping a data type. Tier: High.
    expect(verdict(envelope({ extra: [1, 2] }))).toBe('valid');
    expect(verdict(envelope({ type: 'payment.captured', data: { paymentId: 'p' } }))).toBe('valid');
    expect(verdict(envelope({ type: 'payment.failed', data: { paymentId: 'p' } }))).toBe('valid');
    expect(verdict(envelope({ type: 'payment.refunded', data: { paymentId: 'p', refundId: 'r', amountMinor: 1 } }))).toBe('valid');
  });

  const invalid: [string, unknown][] = [
    ['empty id', envelope({ id: '' })],
    ['numeric id', envelope({ id: 5 })],
    ['unknown type', envelope({ type: 'payment.voided' })],
    ['inherited-property type', envelope({ type: 'constructor' })],
    ['data an array', envelope({ data: [] })],
    ['amount zero', dataWith({ amountMinor: 0 })],
    ['amount fractional', dataWith({ amountMinor: 1.5 })],
    ['amount beyond the safe range', dataWith({ amountMinor: 9007199254740992 })],
    ['amount a string', dataWith({ amountMinor: '100' })],
    ['currency not a string', dataWith({ currency: 5 })],
    ['no splits', dataWith({ splits: [] })],
    ['eleven splits', dataWith({ splits: Array.from({ length: 11 }, (_, index) => split(`m${index}`, index === 0 ? 9990 : 1)) })],
    ['weights sum to 9999', dataWith({ splits: [split('a', 5000), split('b', 4999)] })],
    ['weight above 10000', dataWith({ splits: [split('a', 10001)] })],
    ['negative weight', dataWith({ splits: [split('a', -1), split('b', 10001)] })],
    ['duplicate merchant', dataWith({ splits: [split('a', 5000), split('a', 5000)] })],
    ['empty merchant id', dataWith({ splits: [split('', 10000)] })],
    ['refund without refundId', envelope({ type: 'payment.refunded', data: { paymentId: 'p', amountMinor: 1 } })],
    ['createdAt without seconds', envelope({ createdAt: '2023-11-14T22:13Z' })],
    ['createdAt lowercase t', envelope({ createdAt: '2023-11-14t22:13:20Z' })],
    ['createdAt lowercase z', envelope({ createdAt: '2023-11-14T22:13:20z' })],
    ['createdAt without zone', envelope({ createdAt: '2023-11-14T22:13:20' })],
    ['createdAt month 13', envelope({ createdAt: '2023-13-14T22:13:20Z' })],
    ['createdAt Feb 29 in a common year', envelope({ createdAt: '2023-02-29T00:00:00Z' })],
    ['createdAt Feb 29 in 1900', envelope({ createdAt: '1900-02-29T00:00:00Z' })],
    ['createdAt hour 24', envelope({ createdAt: '2023-11-14T24:00:00Z' })],
    ['createdAt second 60', envelope({ createdAt: '2023-11-14T22:13:60Z' })],
    ['createdAt offset hour 24', envelope({ createdAt: '2023-11-14T22:13:20+24:00' })],
    ['createdAt offset minute 60', envelope({ createdAt: '2023-11-14T22:13:20+01:60' })],
  ];
  for (const [name, body] of invalid) {
    test(`400 invalid_input: ${name}`, () => {
      // Bug caught: a malformed event reaching the ledger. Tier: High.
      expect(verdict(body)).toBe('invalid_input');
    });
  }

  const validDates = ['2024-02-29T23:59:59Z', '2000-02-29T00:00:00.123456+23:59', '2023-12-31T00:00:00-05:30'];
  for (const createdAt of validDates) {
    test(`accepts createdAt ${createdAt}`, () => {
      // Bug caught: calendar check too strict for leap years, fractions and offsets. Tier: High.
      expect(verdict(envelope({ createdAt }))).toBe('valid');
    });
  }

  test('unsupported currency is 422 only when every 400 check has passed', () => {
    // Bug caught: 422 reported for a body that is also invalid (or 400 for a clean unsupported currency). Tier: High.
    expect(verdict(dataWith({ currency: 'usd' }))).toBe('unsupported_currency');
    expect(verdict(dataWith({ currency: 'GBP', amountMinor: 0 }))).toBe('invalid_input');
    expect(verdict(dataWith({ currency: 'GBP', splits: [] }))).toBe('invalid_input');
  });
});

describe('canonicalJson', () => {
  test('is equal for key order, whitespace and number spelling, and differs for any value or extra field', () => {
    // Bug caught: duplicate detection that treats a reordered body as a conflict, or a changed body as a duplicate. Tier: High.
    const canonical = (text: string) => {
      const parsed = parseJsonObject(text);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return canonicalJson(parsed.value);
    };
    expect(canonical('{"b":[1,{"y":1,"x":2}],"a":"s"}')).toBe(canonical('{ "a" : "\\u0073", "b" : [1.0, {"x":2e0,"y":1}] }'));
    expect(canonical('{"a":1}')).not.toBe(canonical('{"a":2}'));
    expect(canonical('{"a":1}')).not.toBe(canonical('{"a":1,"b":null}'));
    expect(canonical('{"a":[1,2]}')).not.toBe(canonical('{"a":[2,1]}'));
  });
});
