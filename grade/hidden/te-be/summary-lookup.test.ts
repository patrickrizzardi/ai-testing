import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, collectMismatches, createSpend, createUser, expectErrorReply, newEnv, summary, userWithBudget, type SummaryBody } from "./harness.ts";

afterEach(cleanupAll);

describe("GET /users/{userId}/budgets/{category}/summary: lookup", () => {
  test("budget the user does not have answers 404 not_found", async () => {
    // Catches: 200 with zeros or 422 for an unknown budget.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    expectErrorReply(await summary(env, userId, "rent"), 404, "not_found");
  });

  test("another user's budget is not visible: 404 not_found", async () => {
    // Catches: looking the budget up by category without the user.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    await userWithBudget(env);
    const stranger = await createUser(env);
    expectErrorReply(await summary(env, stranger, "groceries"), 404, "not_found");
  });

  test("category text that is not a valid category answers 404 not_found, not 400", async () => {
    // Catches: validating the category in the path as input (400) instead of treating it as an unknown budget.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    const names = ["Groceries", "GROCERIES", "a_b", "a.b", "x".repeat(51), "gro%20ceries", "é", "groceries%20", "0", "-"];
    const mismatches = await collectMismatches(names, async (name) => {
      const reply = await summary(env, userId, name);
      return reply.status === 404 && (reply.body as { code?: string })?.code === "not_found" ? undefined : `got ${reply.status} ${reply.text}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("category lookup is exact: a prefix or longer name does not match", async () => {
    // Catches: LIKE 'groc%' style matching.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    for (const name of ["grocer", "groceries2", "groceries-", "roceries"]) expectErrorReply(await summary(env, userId, name), 404, "not_found");
  });

  test("summary has exactly the seven documented keys", async () => {
    // Catches: extra keys such as userId or timeZone, or a renamed key.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    const reply = await summary(env, userId, "groceries");
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body as object).sort()).toEqual(["category", "dailyAllowanceCents", "daysLeft", "limitCents", "month", "remainingCents", "spentCents"]);
    expect(reply.contentType?.split(";")[0]?.trim().toLowerCase()).toBe("application/json");
  });

  test("summary is read-only: repeated reads give the same answer and change no ids", async () => {
    // Catches: a GET that writes (a summary row or an id) as a side effect.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    await createSpend(env, userId, "groceries", 100, "2026-03-10T10:00:00Z");
    const first = await summary(env, userId, "groceries");
    const second = await summary(env, userId, "groceries");
    expect(second.body).toEqual(first.body);
    const next = await createSpend(env, userId, "groceries", 1, "2026-03-11T10:00:00Z");
    expect((next.body as { id: number }).id).toBe(2);
  });
});

describe("GET summary: the injected clock", () => {
  test("every request reads the clock afresh: the same budget reports a new month when now() moves", async () => {
    // Catches: capturing now() once at createApp time.
    const clock = { current: new Date("2026-03-14T12:00:00Z") };
    const env = newEnv(() => clock.current);
    const userId = await userWithBudget(env, { limitCents: 3000 });
    await createSpend(env, userId, "groceries", 500, "2026-03-20T12:00:00Z");
    await createSpend(env, userId, "groceries", 40, "2026-04-02T12:00:00Z");
    const march = (await summary(env, userId, "groceries")).body as SummaryBody;
    clock.current = new Date("2026-04-02T12:00:00Z");
    const april = (await summary(env, userId, "groceries")).body as SummaryBody;
    expect([march.month, march.spentCents, march.daysLeft]).toEqual(["2026-03", 500, 18]);
    expect([april.month, april.spentCents, april.daysLeft]).toEqual(["2026-04", 40, 29]);
  });

  test("a summary request calls now() exactly once, so month and daysLeft come from one instant", async () => {
    // Catches: calling the clock twice (once for the month, once for the day), which can straddle midnight.
    let calls = 0;
    const env = newEnv(() => {
      calls += 1;
      return new Date("2026-03-14T12:00:00Z");
    });
    const userId = await userWithBudget(env);
    calls = 0;
    expect((await summary(env, userId, "groceries")).status).toBe(200);
    expect(calls).toBe(1);
  });

  test("a clock that advances each call still gives one consistent answer per request", async () => {
    // Catches: reading the clock separately for month and daysLeft: this clock moves from 31 March to 1 April on its second call.
    const instants = ["2026-03-31T23:59:59Z", "2026-04-01T00:00:00Z", "2026-04-01T00:00:01Z"];
    let index = 0;
    const env = newEnv(() => new Date(instants[Math.min(index++, instants.length - 1)] as string));
    const userId = await userWithBudget(env);
    index = 0;
    const body = (await summary(env, userId, "groceries")).body as SummaryBody;
    expect([body.month, body.daysLeft]).toEqual(["2026-03", 1]);
  });

  test("without an injected clock the real current time is used", async () => {
    // Catches: a default clock that is fixed, missing, or returns a non-Date.
    const env = newEnv();
    const userId = await userWithBudget(env);
    const before = new Date();
    const body = (await summary(env, userId, "groceries")).body as SummaryBody;
    const after = new Date();
    const monthOf = (date: Date): string => date.toISOString().slice(0, 7);
    expect([monthOf(before), monthOf(after)]).toContain(body.month);
    expect(body.daysLeft).toBeGreaterThanOrEqual(1);
    expect(body.daysLeft).toBeLessThanOrEqual(31);
  });
});
