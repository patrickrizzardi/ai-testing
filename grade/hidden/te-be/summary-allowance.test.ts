import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, collectMismatches, runSummaryScenario } from "./harness.ts";

afterEach(cleanupAll);

// 14 March 2026 UTC: 18 days left including today.
const NOW_WITH_18_DAYS_LEFT = "2026-03-14T12:00:00Z";

describe("remainingCents and dailyAllowanceCents", () => {
  test("allowance is floor(remaining / daysLeft) for positive remaining", async () => {
    // Catches: Math.round or Math.ceil instead of floor; integer-division slips.
    const cases = [
      { limitCents: 50000, spentCents: 12500, remaining: 37500, allowance: 2083 },
      { limitCents: 50000, spentCents: 0, remaining: 50000, allowance: 2777 },
      { limitCents: 18, spentCents: 0, remaining: 18, allowance: 1 },
      { limitCents: 35, spentCents: 0, remaining: 35, allowance: 1 },
      { limitCents: 36, spentCents: 0, remaining: 36, allowance: 2 },
      { limitCents: 1000, spentCents: 1, remaining: 999, allowance: 55 },
      { limitCents: 1000, spentCents: 100, remaining: 900, allowance: 50 },
      { limitCents: 1000000000, spentCents: 0, remaining: 1000000000, allowance: 55555555 },
      { limitCents: 1000000000, spentCents: 1, remaining: 999999999, allowance: 55555555 },
    ];
    const mismatches = await collectMismatches(cases, async ({ limitCents, spentCents, remaining, allowance }) => {
      const spends = spentCents > 0 ? ([[spentCents, "2026-03-10T10:00:00Z"]] as const) : [];
      const { summary } = await runSummaryScenario({ timeZone: "UTC", now: NOW_WITH_18_DAYS_LEFT, limitCents, spends });
      return summary.remainingCents === remaining && summary.dailyAllowanceCents === allowance
        ? undefined
        : `got remaining ${summary.remainingCents}, allowance ${summary.dailyAllowanceCents}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("allowance is 0, not a fraction or 1, when remaining is positive but below daysLeft", async () => {
    // Catches: Math.ceil, or max(1, ...) style clamps.
    const cases = [
      { limitCents: 2, remaining: 2 },
      { limitCents: 17, remaining: 17 },
    ];
    const mismatches = await collectMismatches(cases, async ({ limitCents, remaining }) => {
      const { summary } = await runSummaryScenario({ timeZone: "UTC", now: NOW_WITH_18_DAYS_LEFT, limitCents });
      return summary.remainingCents === remaining && summary.dailyAllowanceCents === 0 ? undefined : `got ${summary.remainingCents} ${summary.dailyAllowanceCents}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("remaining exactly 0: allowance 0", async () => {
    // Catches: dividing and returning NaN, or >= instead of > on the remaining check producing -0.
    const { summary } = await runSummaryScenario({
      timeZone: "UTC",
      now: NOW_WITH_18_DAYS_LEFT,
      limitCents: 400,
      spends: [[400, "2026-03-10T10:00:00Z"]],
    });
    expect(summary.remainingCents).toBe(0);
    expect(Object.is(summary.remainingCents, -0)).toBe(false);
    expect(summary.dailyAllowanceCents).toBe(0);
    expect(Object.is(summary.dailyAllowanceCents, -0)).toBe(false);
  });

  test("negative remaining is reported as negative and the allowance is 0, not negative", async () => {
    // Catches: floor of a negative quotient (-1/18 floors to -1), or clamping remainingCents at 0.
    const cases = [
      { limitCents: 400, spentCents: 401, remaining: -1 },
      { limitCents: 400, spentCents: 417, remaining: -17 },
      { limitCents: 400, spentCents: 418, remaining: -18 },
      { limitCents: 400, spentCents: 1000, remaining: -600 },
    ];
    const mismatches = await collectMismatches(cases, async ({ limitCents, spentCents, remaining }) => {
      const { summary } = await runSummaryScenario({
        timeZone: "UTC",
        now: NOW_WITH_18_DAYS_LEFT,
        limitCents,
        spends: [[spentCents, "2026-03-10T10:00:00Z"]],
      });
      return summary.remainingCents === remaining && summary.dailyAllowanceCents === 0 && !Object.is(summary.dailyAllowanceCents, -0)
        ? undefined
        : `got remaining ${summary.remainingCents}, allowance ${summary.dailyAllowanceCents}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("on the last day of the month the whole remainder is the allowance", async () => {
    // Catches: daysLeft 0 on the last day (division by zero or an off-by-one).
    const { summary } = await runSummaryScenario({
      timeZone: "UTC",
      now: "2026-03-31T23:59:59Z",
      limitCents: 5000,
      spends: [[1234, "2026-03-31T10:00:00Z"]],
    });
    expect(summary.daysLeft).toBe(1);
    expect(summary.dailyAllowanceCents).toBe(3766);
  });

  test("allowance divides by daysLeft of the user's zone: Pacific/Kiritimati vs UTC at the same instant", async () => {
    // Catches: computing daysLeft in UTC while computing the month in the user's zone.
    const instant = "2026-03-31T10:00:00Z";
    const kiritimati = await runSummaryScenario({ timeZone: "Pacific/Kiritimati", now: instant, limitCents: 3000 });
    const utc = await runSummaryScenario({ timeZone: "UTC", now: instant, limitCents: 3000 });
    expect(kiritimati.summary).toMatchObject({ month: "2026-04", daysLeft: 30, dailyAllowanceCents: 100 });
    expect(utc.summary).toMatchObject({ month: "2026-03", daysLeft: 1, dailyAllowanceCents: 3000 });
  });

  test("allowance is exact where a float division could round up: 31 days left", async () => {
    // Catches: float multiplication tricks or toFixed rounding instead of integer floor.
    const cases = [
      { limitCents: 3100, allowance: 100 },
      { limitCents: 3099, allowance: 99 },
      { limitCents: 1000000000, allowance: 32258064 },
    ];
    const mismatches = await collectMismatches(cases, async ({ limitCents, allowance }) => {
      const { summary } = await runSummaryScenario({ timeZone: "UTC", now: "2026-01-01T00:00:00Z", limitCents });
      return summary.daysLeft === 31 && summary.dailyAllowanceCents === allowance ? undefined : `got ${summary.daysLeft} ${summary.dailyAllowanceCents}`;
    });
    expect(mismatches).toEqual([]);
  });
});
