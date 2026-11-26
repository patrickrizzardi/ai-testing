import { expect, test } from 'bun:test';
import { checkCategory, parseJsonObject, parseNewBudget, parseNewUser, parseUserId } from './validation.ts';

// Tier: High (validator). Catches: off-by-one category length limits, a missed character class, a non-string accepted.
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

// Tier: High (validator). Catches: a signed, zero-padded or fractional id accepted.
test.each([
  ['1', 1],
  ['42', 42],
  ['9007199254740991', 9007199254740991],
])('user id %p is %p', (text, userId) => {
  expect(parseUserId(text)).toEqual({ ok: true, value: userId });
});

// Tier: High (validator). Catches: text that names no user answered as invalid_input, or a loss of precision above 2^53 - 1.
test.each(['0', '01', '-1', '+1', '1.5', 'abc', '1e3', '9007199254740992', '9'.repeat(400)])(
  'user id %p names no user',
  (text) => {
    expect(parseUserId(text)).toEqual({ ok: false, error: { code: 'not_found', message: 'user not found' } });
  },
);

// Tier: High (validator). Catches: off-by-one cents limits, a fractional or string number accepted, `5.0` rejected.
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

// Tier: High (validator). Catches: an offset-style or empty time zone accepted, which Intl alone would allow.
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

// Tier: High (validator). Catches: name length counted in UTF-16 units instead of code points.
test.each([
  ['😀'.repeat(100), true],
  ['😀'.repeat(101), false],
  ['', false],
])('a name of %# is valid: %p', (name, isValid) => {
  expect(parseNewUser({ name, timeZone: 'UTC' }).ok).toBe(isValid);
});

// Tier: High (validator, untrusted input). Catches: an unpaired surrogate accepted in any body string (value, unknown field, key, nested), which SQLite would store as U+FFFD.
test.each([
  ['{"name":"\\ud800"}', false],
  ['{"name":"a\\udc00b"}', false],
  ['{"name":"\\udc00\\ud800"}', false],
  ['{"unknown":"\\ud800"}', false],
  ['{"\\ud800":1}', false],
  ['{"list":[1,{"deep":["\\ud800"]}]}', false],
  ['{"name":"\\ud83d\\ude00"}', true],
  ['{"name":"😀"}', true],
])('body %p is well-formed: %p', (bodyText, isWellFormed) => {
  expect(parseJsonObject(bodyText).ok).toBe(isWellFormed);
});
