// Tier: High (authentication). Unit tests of the signature check.
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../src/signature.ts';

const SECRET = 'whsec_example';
const BODY = '{"id":"evt_1","type":"payment.captured","createdAt":"2023-11-14T22:13:20Z","data":{"paymentId":"pay_1"}}';
const SIGNED_AT = 1700000000;
const bytes = (text: string) => new TextEncoder().encode(text);
const sign = (signedAt: string, body: string, secret = SECRET) => createHmac('sha256', secret).update(`${signedAt}.${body}`).digest('hex');

function check(header: string | null, nowSeconds = SIGNED_AT, body = BODY) {
  const result = verifySignature({ header, rawBody: bytes(body), secret: SECRET, nowMilliseconds: nowSeconds * 1000 });
  return result.ok ? 'accepted' : result.error.code;
}

describe('verifySignature', () => {
  test('the worked example of the spec is accepted', () => {
    // Bug caught: wrong signed string or key encoding.
    expect(check('t=1700000000,v1=c4774e8bfe5b84c1dee1146183d174d483187b06388692e3c6d912805c0ad8ea')).toBe('accepted');
  });

  const validSignature = sign('1700000000', BODY);
  const malformedHeaders: [string, string | null][] = [
    ['missing header', null],
    ['parts swapped', `v1=${validSignature},t=1700000000`],
    ['space after the comma', `t=1700000000, v1=${validSignature}`],
    ['extra part', `t=1700000000,v1=${validSignature},v0=ab`],
    ['uppercase hex', `t=1700000000,v1=${validSignature.toUpperCase()}`],
    ['signature too short', `t=1700000000,v1=${validSignature.slice(1)}`],
    ['no digits in t', `t=,v1=${validSignature}`],
    ['16 digits in t', `t=1700000000000000,v1=${sign('1700000000000000', BODY)}`],
    ['signature of another body', `t=1700000000,v1=${sign('1700000000', `${BODY} `)}`],
    ['signature of another t', `t=1700000001,v1=${validSignature}`],
    ['signature of another secret', `t=1700000000,v1=${sign('1700000000', BODY, 'other')}`],
  ];
  for (const [name, header] of malformedHeaders) {
    test(`rejects: ${name}`, () => {
      // Bug caught: accepting a header the contract says is invalid.
      expect(check(header)).toBe('invalid_signature');
    });
  }

  test('freshness window is inclusive at 300 seconds and keeps fractions', () => {
    // Bug caught: off-by-one at the window edge, rounding `now` to whole seconds.
    const header = `t=1700000000,v1=${validSignature}`;
    expect(check(header, SIGNED_AT + 300)).toBe('accepted');
    expect(check(header, SIGNED_AT - 300)).toBe('accepted');
    expect(check(header, SIGNED_AT + 301)).toBe('stale_signature');
    expect(check(header, SIGNED_AT - 301)).toBe('stale_signature');
    const justPast = verifySignature({ header, rawBody: bytes(BODY), secret: SECRET, nowMilliseconds: (SIGNED_AT + 300) * 1000 + 1 });
    expect(justPast.ok ? 'accepted' : justPast.error.code).toBe('stale_signature');
  });

  test('a clock with no valid time fails instead of counting as fresh', () => {
    // Bug caught: NaN from an Invalid Date makes |now - t| > 300 false, so replays pass. Tier: High.
    const header = `t=1700000000,v1=${validSignature}`;
    const result = verifySignature({ header, rawBody: bytes(BODY), secret: SECRET, nowMilliseconds: Number.NaN });
    expect(result.ok ? 'accepted' : result.error.code).toBe('internal_error');
  });

  test('a wrong signature is invalid even when also stale', () => {
    // Bug caught: freshness checked before authenticity, revealing validity to an attacker.
    expect(check(`t=1700000000,v1=${'0'.repeat(64)}`, SIGNED_AT + 10_000)).toBe('invalid_signature');
  });
});
