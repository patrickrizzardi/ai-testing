import { createHmac, timingSafeEqual } from 'node:crypto';
import { apiFailure, type ApiFailure } from './apiError.ts';
import { fail, succeed, type Result } from './result.ts';

const HEADER_SHAPE = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/;
const TOLERANCE_SECONDS = 300;

export type SignatureCheck = {
  header: string | null;
  rawBody: Uint8Array;
  secret: string;
  nowMilliseconds: number;
};

/**
 * Verifies `t=<seconds>,v1=<hmac>` over `<t>.<raw body>`.
 * The HMAC runs over the body bytes as received: for valid UTF-8 that equals the decoded text,
 * and it cannot be changed by decoding (BOM stripping, replacement characters).
 * O(body length) time, O(1) extra memory.
 */
export function verifySignature(check: SignatureCheck): Result<void, ApiFailure> {
  const invalid = fail(apiFailure('invalid_signature', 'Webhook-Signature header is missing or does not match'));
  const parts = check.header === null ? null : HEADER_SHAPE.exec(check.header);
  const signedAtSeconds = parts?.[1];
  const providedHex = parts?.[2];
  if (signedAtSeconds === undefined || providedHex === undefined) return invalid;

  const expected = createHmac('sha256', Buffer.from(check.secret, 'utf8'))
    .update(`${signedAtSeconds}.`, 'utf8')
    .update(check.rawBody)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(providedHex, 'hex'))) return invalid;

  const ageSeconds = Math.abs(check.nowMilliseconds / 1000 - Number(signedAtSeconds));
  if (ageSeconds > TOLERANCE_SECONDS) {
    return fail(apiFailure('stale_signature', `Webhook-Signature is older or newer than ${TOLERANCE_SECONDS} seconds`));
  }
  return succeed(undefined);
}
