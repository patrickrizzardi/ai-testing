import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, collectMismatches, runSummaryScenario } from "./harness.ts";

afterEach(cleanupAll);

describe("summary month and daysLeft come from now() in the user's time zone", () => {
  test("the spec example: Paris, 14 March 2026, 50000 limit, 12500 spent", async () => {
    // Catches: wrong response shape or arithmetic in the documented example.
    const { reply } = await runSummaryScenario({
      timeZone: "Europe/Paris",
      now: "2026-03-14T20:00:00Z",
      limitCents: 50000,
      spends: [[12500, "2026-03-14T18:30:00+01:00"]],
    });
    expect(reply.body).toEqual({
      category: "groceries",
      month: "2026-03",
      limitCents: 50000,
      spentCents: 12500,
      remainingCents: 37500,
      daysLeft: 18,
      dailyAllowanceCents: 2083,
    });
  });

  test("daysLeft counts today through the last day: first, middle and last day of 30- and 31-day months", async () => {
    // Catches: off-by-one (excluding today, or counting the day after the last day).
    const cases = [
      { now: "2026-01-01T12:00:00Z", month: "2026-01", daysLeft: 31 },
      { now: "2026-01-31T12:00:00Z", month: "2026-01", daysLeft: 1 },
      { now: "2026-03-14T12:00:00Z", month: "2026-03", daysLeft: 18 },
      { now: "2026-03-31T12:00:00Z", month: "2026-03", daysLeft: 1 },
      { now: "2026-04-01T12:00:00Z", month: "2026-04", daysLeft: 30 },
      { now: "2026-04-30T12:00:00Z", month: "2026-04", daysLeft: 1 },
      { now: "2026-12-01T12:00:00Z", month: "2026-12", daysLeft: 31 },
      { now: "2026-12-31T12:00:00Z", month: "2026-12", daysLeft: 1 },
    ];
    const mismatches = await collectMismatches(cases, async ({ now, month, daysLeft }) => {
      const { summary } = await runSummaryScenario({ timeZone: "UTC", now, limitCents: 100 });
      return summary.month === month && summary.daysLeft === daysLeft ? undefined : `got ${summary.month} ${summary.daysLeft}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("daysLeft in February: leap years 2028 and 2000, non-leap 2026 and 2100", async () => {
    // Catches: hard-coded 28 days, a plain divisible-by-4 leap rule (2100), a missing divisible-by-400 rule (2000).
    const cases = [
      { now: "2028-02-01T12:00:00Z", daysLeft: 29 },
      { now: "2028-02-10T12:00:00Z", daysLeft: 20 },
      { now: "2028-02-28T12:00:00Z", daysLeft: 2 },
      { now: "2028-02-29T12:00:00Z", daysLeft: 1 },
      { now: "2026-02-01T12:00:00Z", daysLeft: 28 },
      { now: "2026-02-10T12:00:00Z", daysLeft: 19 },
      { now: "2026-02-28T12:00:00Z", daysLeft: 1 },
      { now: "2100-02-01T12:00:00Z", daysLeft: 28 },
      { now: "2100-02-28T12:00:00Z", daysLeft: 1 },
      { now: "2000-02-01T12:00:00Z", daysLeft: 29 },
      { now: "2000-02-29T12:00:00Z", daysLeft: 1 },
    ];
    const mismatches = await collectMismatches(cases, async ({ now, daysLeft }) => {
      const { summary } = await runSummaryScenario({ timeZone: "UTC", now, limitCents: 100 });
      return summary.daysLeft === daysLeft && summary.month === now.slice(0, 7) ? undefined : `got ${summary.month} ${summary.daysLeft}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("time of day does not change daysLeft: midnight and the last millisecond of a day agree", async () => {
    // Catches: computing daysLeft from elapsed milliseconds (rounding up or down).
    const cases = ["2026-03-14T00:00:00.000Z", "2026-03-14T00:00:00.001Z", "2026-03-14T12:00:00Z", "2026-03-14T23:59:59.999Z"];
    const mismatches = await collectMismatches(cases, async (now) => {
      const { summary } = await runSummaryScenario({ timeZone: "UTC", now, limitCents: 100 });
      return summary.daysLeft === 18 ? undefined : `got ${summary.daysLeft}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("the month rolls over at local midnight: now just before and after midnight in several zones", async () => {
    // Catches: taking month and day from UTC instead of the user's zone (month, daysLeft or both wrong).
    const cases = [
      { timeZone: "Europe/Paris", now: "2026-03-31T23:30:00Z", month: "2026-04", daysLeft: 30 },
      { timeZone: "America/Los_Angeles", now: "2026-03-31T23:30:00Z", month: "2026-03", daysLeft: 1 },
      { timeZone: "America/Los_Angeles", now: "2026-04-01T06:59:59Z", month: "2026-03", daysLeft: 1 },
      { timeZone: "America/Los_Angeles", now: "2026-04-01T07:00:00Z", month: "2026-04", daysLeft: 30 },
      { timeZone: "Asia/Tokyo", now: "2026-12-31T23:30:00Z", month: "2027-01", daysLeft: 31 },
      { timeZone: "America/Los_Angeles", now: "2027-01-01T03:00:00Z", month: "2026-12", daysLeft: 1 },
      { timeZone: "Pacific/Kiritimati", now: "2026-03-31T10:00:00Z", month: "2026-04", daysLeft: 30 },
      { timeZone: "Pacific/Pago_Pago", now: "2026-04-01T10:59:59Z", month: "2026-03", daysLeft: 1 },
      { timeZone: "Pacific/Pago_Pago", now: "2026-04-01T11:00:00Z", month: "2026-04", daysLeft: 30 },
      { timeZone: "Asia/Kolkata", now: "2026-03-31T18:29:59Z", month: "2026-03", daysLeft: 1 },
      { timeZone: "Asia/Kolkata", now: "2026-03-31T18:30:00Z", month: "2026-04", daysLeft: 30 },
    ];
    const mismatches = await collectMismatches(cases, async ({ timeZone, now, month, daysLeft }) => {
      const { summary } = await runSummaryScenario({ timeZone, now, limitCents: 100 });
      return summary.month === month && summary.daysLeft === daysLeft ? undefined : `got ${summary.month} ${summary.daysLeft}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("daysLeft counts calendar days across a daylight-saving change, not 24-hour periods", async () => {
    // Catches: (endOfMonth - now) / 24h, which is off by an hour-fraction on DST days.
    const cases = [
      { timeZone: "Europe/Paris", now: "2026-03-29T00:30:00Z", month: "2026-03", daysLeft: 3 },
      { timeZone: "Europe/Paris", now: "2026-03-29T10:00:00Z", month: "2026-03", daysLeft: 3 },
      { timeZone: "Europe/Paris", now: "2026-03-31T21:59:59Z", month: "2026-03", daysLeft: 1 },
      { timeZone: "Europe/Paris", now: "2026-03-31T22:00:00Z", month: "2026-04", daysLeft: 30 },
      { timeZone: "America/Los_Angeles", now: "2026-11-01T07:59:00Z", month: "2026-11", daysLeft: 30 },
      { timeZone: "America/Los_Angeles", now: "2026-11-01T20:00:00Z", month: "2026-11", daysLeft: 30 },
      { timeZone: "America/Los_Angeles", now: "2026-03-08T12:00:00Z", month: "2026-03", daysLeft: 24 },
      { timeZone: "Europe/Paris", now: "2026-10-31T22:59:59Z", month: "2026-10", daysLeft: 1 },
      { timeZone: "Europe/Paris", now: "2026-10-31T23:00:00Z", month: "2026-11", daysLeft: 30 },
    ];
    const mismatches = await collectMismatches(cases, async ({ timeZone, now, month, daysLeft }) => {
      const { summary } = await runSummaryScenario({ timeZone, now, limitCents: 100 });
      return summary.month === month && summary.daysLeft === daysLeft ? undefined : `got ${summary.month} ${summary.daysLeft}`;
    });
    expect(mismatches).toEqual([]);
  });
});
