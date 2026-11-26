import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, collectMismatches, createBudget, createSpend, createUser, newEnv, runSummaryScenario, summary, userWithBudget, type SummaryBody } from "./harness.ts";

afterEach(cleanupAll);

type BoundaryCase = { label: string; spentAt: string; counted: boolean };

/** One budget, `now` in the target month, one 100-cent spend per case; reports each case's inclusion. */
async function boundaryMismatches(timeZone: string, now: string, cases: readonly BoundaryCase[]): Promise<string[]> {
  return collectMismatches(cases, async ({ spentAt, counted }) => {
    const { summary: body } = await runSummaryScenario({ timeZone, now, limitCents: 1000, spends: [[100, spentAt]] });
    const expected = counted ? 100 : 0;
    return body.spentCents === expected ? undefined : `spentCents ${body.spentCents}, expected ${expected}`;
  });
}

describe("spentCents: the user's calendar month, from its first instant up to the next month's first instant", () => {
  test("user west of UTC (Los Angeles, April 2026): both month edges", async () => {
    // Catches: slicing the month from the UTC date (a spend at 06:59:59Z on 1 April is still 31 March in Los Angeles).
    const mismatches = await boundaryMismatches("America/Los_Angeles", "2026-04-15T12:00:00Z", [
      { label: "last second of March local", spentAt: "2026-04-01T06:59:59Z", counted: false },
      { label: "first second of April local", spentAt: "2026-04-01T07:00:00Z", counted: true },
      { label: "last second of April local", spentAt: "2026-05-01T06:59:59Z", counted: true },
      { label: "first second of May local", spentAt: "2026-05-01T07:00:00Z", counted: false },
    ]);
    expect(mismatches).toEqual([]);
  });

  test("user east of UTC (Auckland, April 2026): both month edges, offset change inside the month", async () => {
    // Catches: using UTC, or one fixed offset for the whole month (Auckland leaves daylight time on 5 April).
    const mismatches = await boundaryMismatches("Pacific/Auckland", "2026-04-10T00:00:00Z", [
      { label: "last second of March local", spentAt: "2026-03-31T10:59:59Z", counted: false },
      { label: "first second of April local", spentAt: "2026-03-31T11:00:00Z", counted: true },
      { label: "last second of April local", spentAt: "2026-04-30T11:59:59Z", counted: true },
      { label: "first second of May local", spentAt: "2026-04-30T12:00:00Z", counted: false },
    ]);
    expect(mismatches).toEqual([]);
  });

  test("half-hour zone (Kolkata, April 2026): both month edges", async () => {
    // Catches: truncating the offset to whole hours.
    const mismatches = await boundaryMismatches("Asia/Kolkata", "2026-04-15T12:00:00Z", [
      { label: "last second of March local", spentAt: "2026-03-31T18:29:59Z", counted: false },
      { label: "first second of April local", spentAt: "2026-03-31T18:30:00Z", counted: true },
      { label: "last second of April local", spentAt: "2026-04-30T18:29:59Z", counted: true },
      { label: "first second of May local", spentAt: "2026-04-30T18:30:00Z", counted: false },
    ]);
    expect(mismatches).toEqual([]);
  });

  test("Paris, October 2026: the month starts in summer time and ends in winter time", async () => {
    // Catches: applying today's UTC offset to both month edges.
    const mismatches = await boundaryMismatches("Europe/Paris", "2026-10-15T12:00:00Z", [
      { label: "last second of September local (UTC+2)", spentAt: "2026-09-30T21:59:59Z", counted: false },
      { label: "first second of October local (UTC+2)", spentAt: "2026-09-30T22:00:00Z", counted: true },
      { label: "last second of October local (UTC+1)", spentAt: "2026-10-31T22:59:59Z", counted: true },
      { label: "first second of November local (UTC+1)", spentAt: "2026-10-31T23:00:00Z", counted: false },
    ]);
    expect(mismatches).toEqual([]);
  });

  test("UTC user: month edges, and a sub-millisecond-late instant stays in the earlier month", async () => {
    // Catches: rounding spentAt up (the 9-digit fraction 23:59:59.999999999 is still before April) or comparing dates as text.
    const mismatches = await boundaryMismatches("UTC", "2026-03-20T12:00:00Z", [
      { label: "last second of February", spentAt: "2026-02-28T23:59:59Z", counted: false },
      { label: "first instant of March", spentAt: "2026-03-01T00:00:00Z", counted: true },
      { label: "last nanosecond-ish of March", spentAt: "2026-03-31T23:59:59.999999999Z", counted: true },
      { label: "first instant of April", spentAt: "2026-04-01T00:00:00Z", counted: false },
      { label: "first instant of April, written -00:00", spentAt: "2026-04-01T00:00:00-00:00", counted: false },
    ]);
    expect(mismatches).toEqual([]);
  });

  test("the offset in spentAt only locates the instant: it is then viewed in the user's zone", async () => {
    // Catches: reading the date or month straight from spentAt's text, ignoring its offset.
    const mismatches = await boundaryMismatches("UTC", "2026-04-15T12:00:00Z", [
      { label: "text says April 1, instant is 31 March 10:30Z", spentAt: "2026-04-01T00:30:00+14:00", counted: false },
      { label: "text says 31 March, instant is 1 April 04:30Z", spentAt: "2026-03-31T23:30:00-05:00", counted: true },
      { label: "text says May 1, instant is 30 April 23:00Z", spentAt: "2026-05-01T00:00:00+01:00", counted: true },
      { label: "text says April 30, instant is 1 May 03:30Z", spentAt: "2026-04-30T23:59:59-03:30", counted: false },
    ]);
    expect(mismatches).toEqual([]);
  });

  test("the same instant lands in different months for users in different zones", async () => {
    // Catches: storing a month key at spend time, or sharing one zone across users.
    const env = newEnv(() => new Date("2026-04-15T12:00:00Z"));
    const tokyo = await userWithBudget(env, { timeZone: "Asia/Tokyo", limitCents: 1000 });
    const lima = await userWithBudget(env, { timeZone: "America/Lima", limitCents: 1000 });
    const instant = "2026-03-31T20:00:00Z";
    await createSpend(env, tokyo, "groceries", 100, instant);
    await createSpend(env, lima, "groceries", 100, instant);
    expect(((await summary(env, tokyo, "groceries")).body as SummaryBody).spentCents).toBe(100);
    expect(((await summary(env, lima, "groceries")).body as SummaryBody).spentCents).toBe(0);
  });

  test("a spend counts toward the month that now() falls in, in the user's zone", async () => {
    // Catches: choosing the target month from UTC now while bucketing spends by local month.
    const { summary: body } = await runSummaryScenario({
      timeZone: "Europe/Paris",
      now: "2026-03-31T23:30:00Z",
      limitCents: 10000,
      spends: [
        [700, "2026-04-01T00:30:00+02:00"],
        [300, "2026-03-31T23:30:00Z"],
        [50, "2026-03-31T23:59:59+02:00"],
      ],
    });
    expect(body.month).toBe("2026-04");
    expect(body.spentCents).toBe(1000);
  });

  test("spends in other months and years are excluded", async () => {
    // Catches: summing all spends of the category, or matching the month number without the year.
    const { summary: body } = await runSummaryScenario({
      timeZone: "UTC",
      now: "2026-03-14T12:00:00Z",
      limitCents: 1000,
      spends: [
        [1, "2025-03-14T12:00:00Z"],
        [2, "2027-03-14T12:00:00Z"],
        [4, "2026-02-14T12:00:00Z"],
        [8, "2026-04-14T12:00:00Z"],
        [16, "2026-03-14T12:00:00Z"],
        [32, "2026-03-01T00:00:00Z"],
      ],
    });
    expect(body.spentCents).toBe(48);
  });

  test("spends are summed by category: other categories of the same user are excluded", async () => {
    // Catches: summing every spend of the user.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env, { limitCents: 1000 });
    await createBudget(env, userId, "rent", 1000);
    await createSpend(env, userId, "groceries", 10, "2026-03-10T10:00:00Z");
    await createSpend(env, userId, "rent", 200, "2026-03-10T10:00:00Z");
    await createSpend(env, userId, "groceries", 5, "2026-03-11T10:00:00Z");
    expect(((await summary(env, userId, "groceries")).body as SummaryBody).spentCents).toBe(15);
    expect(((await summary(env, userId, "rent")).body as SummaryBody).spentCents).toBe(200);
  });

  test("spends are summed per user: another user's spends in the same category are excluded", async () => {
    // Catches: a spend query without the user filter.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const first = await userWithBudget(env, { limitCents: 1000 });
    const second = await userWithBudget(env, { limitCents: 5000 });
    await createSpend(env, first, "groceries", 11, "2026-03-10T10:00:00Z");
    await createSpend(env, second, "groceries", 222, "2026-03-10T10:00:00Z");
    expect((await summary(env, first, "groceries")).body).toMatchObject({ limitCents: 1000, spentCents: 11 });
    expect((await summary(env, second, "groceries")).body).toMatchObject({ limitCents: 5000, spentCents: 222 });
  });

  test("a month with no spends reports spentCents 0 and the full limit remaining", async () => {
    // Catches: null from SUM() leaking out, or a 404 when there are no spends.
    const { summary: body } = await runSummaryScenario({ timeZone: "UTC", now: "2026-03-14T12:00:00Z", limitCents: 50000 });
    expect(body).toEqual({
      category: "groceries",
      month: "2026-03",
      limitCents: 50000,
      spentCents: 0,
      remainingCents: 50000,
      daysLeft: 18,
      dailyAllowanceCents: 2777,
    });
  });

  test("sums above 2^31 do not overflow: three 1,000,000,000 spends", async () => {
    // Catches: 32-bit arithmetic on the sum.
    const { summary: body } = await runSummaryScenario({
      timeZone: "UTC",
      now: "2026-03-14T12:00:00Z",
      limitCents: 1000000000,
      spends: [
        [1000000000, "2026-03-01T00:00:00Z"],
        [1000000000, "2026-03-02T00:00:00Z"],
        [1000000000, "2026-03-03T00:00:00Z"],
      ],
    });
    expect(body.spentCents).toBe(3000000000);
    expect(body.remainingCents).toBe(-2000000000);
    expect(body.dailyAllowanceCents).toBe(0);
  });

  test("spends in a month other than now()'s (including the future) are accepted but not counted", async () => {
    // Catches: ignoring `now` (summing everything) or rejecting future spends.
    const { summary: body } = await runSummaryScenario({
      timeZone: "UTC",
      now: "2026-03-14T12:00:00Z",
      limitCents: 100,
      spends: [
        [5, "2026-03-15T00:00:00Z"],
        [7, "2030-01-01T00:00:00Z"],
      ],
    });
    expect(body.spentCents).toBe(5);
  });
});
