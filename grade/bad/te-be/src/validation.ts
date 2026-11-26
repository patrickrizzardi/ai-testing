import { parseTimeZone } from './calendar.ts';
import type { NewBudget, NewSpend, NewUser } from './domain.ts';
import { failWith, invalidInput, type AppError } from './errors.ts';
import { succeed, type Result } from './result.ts';
import { parseSpentAt } from './timestamp.ts';

type JsonObject = Record<string, unknown>;

const MAX_CENTS = 1_000_000_000;
const CATEGORY_PATTERN = /^[a-z0-9-]+$/;
const USER_ID_PATTERN = /^[1-9][0-9]*$/;

/** O(n) time, O(1) memory. */
function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * True when every string in the parsed JSON, object keys and values nested at any depth included,
 * is well-formed Unicode. O(n) time and memory in the size of the value; an explicit stack, not
 * recursion, so a deeply nested body cannot overflow the call stack.
 */
function isWellFormedJson(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (!value.isWellFormed()) return false;
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (!key.isWellFormed()) return false;
        pending.push(child);
      }
    }
  }
  return true;
}

export function parseJsonObject(bodyText: string): Result<JsonObject, AppError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return invalidInput('body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalidInput('body must be a JSON object');
  }
  if (!isWellFormedJson(parsed)) return invalidInput('body strings must be well-formed Unicode');
  return succeed(parsed as JsonObject);
}

/** A `{userId}` path segment. Text that names no user is `not_found`, not `invalid_input`. */
export function parseUserId(text: string): Result<number, AppError> {
  const userId = USER_ID_PATTERN.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(userId)) return failWith('not_found', 'user not found');
  return succeed(userId);
}

function checkText(field: string, value: unknown, minLength: number, maxLength: number): Result<string, AppError> {
  if (typeof value !== 'string') return invalidInput(`${field} must be a string`);
  const length = countCodePoints(value);
  if (length < minLength || length > maxLength) {
    return invalidInput(`${field} must be ${minLength}-${maxLength} characters`);
  }
  return succeed(value);
}

/** Shared by budgets and spends, and by the summary route's `{category}` segment. */
export function checkCategory(value: unknown): Result<string, AppError> {
  const category = checkText('category', value, 1, 50);
  if (!category.ok) return category;
  if (!CATEGORY_PATTERN.test(category.value)) {
    return invalidInput('category may only contain a-z, 0-9 and -');
  }
  return category;
}

/** Shared by `limitCents` and `amountCents`. A whole number written as `5.0` or `5e0` is an integer. */
function checkCents(field: string, value: unknown): Result<number, AppError> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CENTS) {
    return invalidInput(`${field} must be an integer from 1 to ${MAX_CENTS}`);
  }
  return succeed(value);
}

function checkTimeZone(value: unknown): Result<string, AppError> {
  if (typeof value !== 'string') return invalidInput('timeZone must be a string');
  const timeZone = parseTimeZone(value);
  return timeZone.ok ? timeZone : invalidInput(`timeZone ${timeZone.error}`);
}

function checkSpentAt(value: unknown): Result<Pick<NewSpend, 'spentAt' | 'spentAtEpochMs'>, AppError> {
  if (typeof value !== 'string') return invalidInput('spentAt must be a string');
  const epochMs = parseSpentAt(value);
  if (!epochMs.ok) return invalidInput(`spentAt ${epochMs.error}`);
  return succeed({ spentAt: value, spentAtEpochMs: epochMs.value });
}

export function parseNewUser(body: JsonObject): Result<NewUser, AppError> {
  const name = checkText('name', body['name'], 1, 100);
  if (!name.ok) return name;
  const timeZone = checkTimeZone(body['timeZone']);
  if (!timeZone.ok) return timeZone;
  return succeed({ name: name.value, timeZone: timeZone.value });
}

export function parseNewBudget(body: JsonObject): Result<NewBudget, AppError> {
  const category = checkCategory(body['category']);
  if (!category.ok) return category;
  const limitCents = checkCents('limitCents', body['limitCents']);
  if (!limitCents.ok) return limitCents;
  return succeed({ category: category.value, limitCents: limitCents.value });
}

export function parseNewSpend(body: JsonObject): Result<NewSpend, AppError> {
  const category = checkCategory(body['category']);
  if (!category.ok) return category;
  const amountCents = checkCents('amountCents', body['amountCents']);
  if (!amountCents.ok) return amountCents;
  const spentAt = checkSpentAt(body['spentAt']);
  if (!spentAt.ok) return spentAt;
  return succeed({ category: category.value, amountCents: amountCents.value, ...spentAt.value });
}
