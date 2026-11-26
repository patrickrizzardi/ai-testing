import { expect, test } from 'bun:test';
import { summarizeBudget } from './summary.ts';

const budget = { category: 'groceries', limitCents: 50_000 };

// Tier: High (calendar and money arithmetic). Catches: UTC month windows, daysLeft off-by-one, negative allowance.
test('the month window and daysLeft follow the user zone, not UTC', () => {
  const lateMarchInParisIsAprilNowhereElse = Date.UTC(2026, 2, 31, 23, 30);
  const spends = [
    { amountCents: 1_000, spentAtEpochMs: Date.UTC(2026, 2, 31, 21, 59) },
    { amountCents: 200, spentAtEpochMs: Date.UTC(2026, 2, 31, 22, 0) },
  ];
  expect(summarizeBudget({ budget, spends, timeZone: 'Europe/Paris', nowEpochMs: lateMarchInParisIsAprilNowhereElse })).toEqual({
    category: 'groceries',
    month: '2026-04',
    limitCents: 50_000,
    spentCents: 200,
    remainingCents: 49_800,
    daysLeft: 30,
    dailyAllowanceCents: 1_660,
  });
});

test.each([
  ['2026-01-31', Date.UTC(2026, 0, 31, 12), 1],
  ['2028-02-01', Date.UTC(2028, 1, 1, 12), 29],
  ['2026-03-29 (clocks change)', Date.UTC(2026, 2, 29, 10), 3],
])('daysLeft on %s is %i', (_label, nowEpochMs, daysLeft) => {
  expect(summarizeBudget({ budget, spends: [], timeZone: 'Europe/Paris', nowEpochMs }).daysLeft).toBe(daysLeft);
});

test('a spent budget has a negative remainder and a zero allowance', () => {
  const spends = [{ amountCents: 60_000, spentAtEpochMs: Date.UTC(2026, 2, 5) }];
  const summary = summarizeBudget({ budget, spends, timeZone: 'UTC', nowEpochMs: Date.UTC(2026, 2, 14) });
  expect([summary.remainingCents, summary.dailyAllowanceCents]).toEqual([-10_000, 0]);
});
