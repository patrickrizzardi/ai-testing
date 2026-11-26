import { expect, test } from 'bun:test';
import { checkCategory, parseNewBudget, parseNewUser, parseUserId } from './validation.ts';

// Tier: High (validators). Catches: off-by-one length limits, code-point vs UTF-16 length, a missed character class.
test.each([
  ['a', true],
  ['a'.repeat(50), true],
  ['0-9-z', true],
  ['', false],
  ['a'.repeat(51), false],
  ['Groceries', false],
  ['food_and_drink', false],
  ['café', false],
  ['a\n', false],
  [5, false],
  [null, false],
])('category %p is valid: %p', (category, isValid) => {
  expect(checkCategory(category).ok).toBe(isValid);
});

test.each([
  ['1', 1],
  ['42', 42],
  ['9007199254740991', 9007199254740991],
])('user id %p is %p', (text, userId) => {
  expect(parseUserId(text)).toEqual({ ok: true, value: userId });
});

test.each(['0', '01', '-1', '+1', '1.5', 'abc', '1e3', '9007199254740992', '9'.repeat(400)])(
  'user id %p names no user',
  (text) => {
    expect(parseUserId(text)).toEqual({ ok: false, error: { code: 'not_found', message: 'user not found' } });
  },
);

test.each([
  [1, true],
  [1_000_000_000, true],
  [5.0, true],
  [0, false],
  [1_000_000_001, false],
  [1.5, false],
  [Number.NaN, false],
  ['5', false],
  [null, false],
])('limitCents %p is valid: %p', (limitCents, isValid) => {
  expect(parseNewBudget({ category: 'food', limitCents }).ok).toBe(isValid);
});

test.each([
  ['Europe/Paris', true],
  ['UTC', true],
  ['+02:00', false],
  ['-05:00', false],
  ['', false],
  ['Mars/Base', false],
])('timeZone %p is valid: %p', (timeZone, isValid) => {
  expect(parseNewUser({ name: 'Ada', timeZone }).ok).toBe(isValid);
});

test.each([
  ['😀'.repeat(100), true],
  ['😀'.repeat(101), false],
  ['', false],
])('a name of %# is valid: %p', (name, isValid) => {
  expect(parseNewUser({ name, timeZone: 'UTC' }).ok).toBe(isValid);
});
