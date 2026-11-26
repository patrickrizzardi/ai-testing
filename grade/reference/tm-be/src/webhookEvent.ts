import { apiFailure, type ApiFailure } from './apiError.ts';
import { isJsonObject, isWholeNumberInRange, type JsonObject } from './json.ts';
import { fail, succeed, type Result } from './result.ts';
import { isSupportedCurrency, type Currency } from './types.ts';

export type Split = { merchantId: string; weightBps: number };

export type WebhookEvent =
  | { kind: 'authorized'; eventId: string; paymentId: string; amountMinor: number; currency: Currency; splits: Split[] }
  | { kind: 'captured'; eventId: string; paymentId: string }
  | { kind: 'failed'; eventId: string; paymentId: string }
  | { kind: 'refunded'; eventId: string; paymentId: string; refundId: string; amountMinor: number };

export type EventKind = WebhookEvent['kind'];

const KIND_OF_TYPE: ReadonlyMap<unknown, EventKind> = new Map<unknown, EventKind>([
  ['payment.authorized', 'authorized'],
  ['payment.captured', 'captured'],
  ['payment.failed', 'failed'],
  ['payment.refunded', 'refunded'],
]);

const MAX_SPLITS = 10;
const TOTAL_WEIGHT_BPS = 10000;
const CREATED_AT_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

type Field<Value> = Result<Value, ApiFailure>;

const invalidInput = (message: string) => fail(apiFailure('invalid_input', message));

function readText(object: JsonObject, key: string, label: string): Field<string> {
  const value = object[key];
  return typeof value === 'string' && value.length > 0 ? succeed(value) : invalidInput(`${label} must be a non-empty string`);
}

function readWholeNumber(object: JsonObject, key: string, label: string, minimum: number, maximum: number): Field<number> {
  const value = object[key];
  return isWholeNumberInRange(value, minimum, maximum)
    ? succeed(value)
    : invalidInput(`${label} must be an integer from ${minimum} to ${maximum}`);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** RFC 3339 date-time with a real calendar date and clock time; uppercase T and Z only. */
function isRfc3339DateTime(text: string): boolean {
  const parts = CREATED_AT_SHAPE.exec(text);
  if (parts === null) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const [offsetHour, offsetMinute] = [parts[7], parts[8]].map((digits) => (digits === undefined ? 0 : Number(digits)));
  return (
    month !== undefined && month >= 1 && month <= 12 &&
    year !== undefined && day !== undefined && day >= 1 && day <= daysInMonth(year, month) &&
    hour !== undefined && hour <= 23 &&
    minute !== undefined && minute <= 59 &&
    second !== undefined && second <= 59 &&
    offsetHour !== undefined && offsetHour <= 23 &&
    offsetMinute !== undefined && offsetMinute <= 59
  );
}

function readSplits(object: JsonObject): Field<Split[]> {
  const value = object.splits;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SPLITS) {
    return invalidInput(`data.splits must be an array of 1 to ${MAX_SPLITS} objects`);
  }
  const splits: Split[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) return invalidInput('data.splits entries must be objects');
    const merchantId = readText(entry, 'merchantId', 'data.splits[].merchantId');
    if (!merchantId.ok) return merchantId;
    const weightBps = readWholeNumber(entry, 'weightBps', 'data.splits[].weightBps', 0, TOTAL_WEIGHT_BPS);
    if (!weightBps.ok) return weightBps;
    splits.push({ merchantId: merchantId.value, weightBps: weightBps.value });
  }
  if (new Set(splits.map((split) => split.merchantId)).size !== splits.length) {
    return invalidInput('data.splits merchantId values must be pairwise different');
  }
  if (splits.reduce((sum, split) => sum + split.weightBps, 0) !== TOTAL_WEIGHT_BPS) {
    return invalidInput(`data.splits weightBps must sum to ${TOTAL_WEIGHT_BPS}`);
  }
  return succeed(splits);
}

function readAuthorized(eventId: string, data: JsonObject): Result<WebhookEvent, ApiFailure> {
  const paymentId = readText(data, 'paymentId', 'data.paymentId');
  if (!paymentId.ok) return paymentId;
  const amountMinor = readWholeNumber(data, 'amountMinor', 'data.amountMinor', 1, Number.MAX_SAFE_INTEGER);
  if (!amountMinor.ok) return amountMinor;
  const currency = data.currency;
  if (typeof currency !== 'string') return invalidInput('data.currency must be a string');
  const splits = readSplits(data);
  if (!splits.ok) return splits;
  // Only after every 400 check has passed: an unsupported currency is a 422, not a 400.
  if (!isSupportedCurrency(currency)) return fail(apiFailure('unsupported_currency', `Currency ${JSON.stringify(currency)} is not supported`));
  return succeed({ kind: 'authorized', eventId, paymentId: paymentId.value, amountMinor: amountMinor.value, currency, splits: splits.value });
}

function readRefunded(eventId: string, data: JsonObject): Result<WebhookEvent, ApiFailure> {
  const paymentId = readText(data, 'paymentId', 'data.paymentId');
  if (!paymentId.ok) return paymentId;
  const refundId = readText(data, 'refundId', 'data.refundId');
  if (!refundId.ok) return refundId;
  const amountMinor = readWholeNumber(data, 'amountMinor', 'data.amountMinor', 1, Number.MAX_SAFE_INTEGER);
  if (!amountMinor.ok) return amountMinor;
  return succeed({ kind: 'refunded', eventId, paymentId: paymentId.value, refundId: refundId.value, amountMinor: amountMinor.value });
}

function readPaymentReference(kind: 'captured' | 'failed', eventId: string, data: JsonObject): Result<WebhookEvent, ApiFailure> {
  const paymentId = readText(data, 'paymentId', 'data.paymentId');
  return paymentId.ok ? succeed({ kind, eventId, paymentId: paymentId.value }) : paymentId;
}

/** Validates the parsed body of a webhook request; fields beyond the documented ones are ignored. O(body size). */
export function validateEvent(body: JsonObject): Result<WebhookEvent, ApiFailure> {
  const eventId = readText(body, 'id', 'id');
  if (!eventId.ok) return eventId;
  const type = body.type;
  const kind = KIND_OF_TYPE.get(type);
  if (kind === undefined) return invalidInput('type must be one of payment.authorized, payment.captured, payment.failed, payment.refunded');
  const createdAt = body.createdAt;
  if (typeof createdAt !== 'string' || !isRfc3339DateTime(createdAt)) return invalidInput('createdAt must be an RFC 3339 date-time');
  const data = body.data;
  if (!isJsonObject(data)) return invalidInput('data must be an object');

  switch (kind) {
    case 'authorized':
      return readAuthorized(eventId.value, data);
    case 'refunded':
      return readRefunded(eventId.value, data);
    case 'captured':
    case 'failed':
      return readPaymentReference(kind, eventId.value, data);
  }
}
