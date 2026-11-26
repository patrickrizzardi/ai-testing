import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, createApp, createBudget, createSpend, createUser, expectErrorReply, fixedClock, newEnv, post, summary, userWithBudget, type SummaryBody } from "./harness.ts";

afterEach(cleanupAll);

describe("persistence across createApp instances on one database file", () => {
  test("users, budgets and spends created before close() are all there after reopening", async () => {
    // Catches: an in-memory store, or a schema recreated (data dropped) on every createApp.
    const env = newEnv(fixedClock("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env, { timeZone: "Europe/Paris", limitCents: 50000 });
    await createSpend(env, userId, "groceries", 1250, "2026-03-14T18:30:00+01:00");
    await createSpend(env, userId, "groceries", 750, "2026-03-02T08:00:00+01:00");
    env.reopen();
    const body = (await summary(env, userId, "groceries")).body as SummaryBody;
    expect(body).toEqual({
      category: "groceries",
      month: "2026-03",
      limitCents: 50000,
      spentCents: 2000,
      remainingCents: 48000,
      daysLeft: 18,
      dailyAllowanceCents: 2666,
    });
  });

  test("the stored time zone is kept: month edges still follow the user's zone after reopening", async () => {
    // Catches: not persisting timeZone, so the reopened app falls back to UTC.
    const env = newEnv(fixedClock("2026-04-15T12:00:00Z"));
    const userId = await userWithBudget(env, { timeZone: "America/Los_Angeles", limitCents: 1000 });
    await createSpend(env, userId, "groceries", 100, "2026-04-01T06:59:59Z");
    await createSpend(env, userId, "groceries", 10, "2026-04-01T07:00:00Z");
    env.reopen();
    expect(((await summary(env, userId, "groceries")).body as SummaryBody).spentCents).toBe(10);
  });

  test("a budget that existed before reopening still answers 409 budget_exists", async () => {
    // Catches: uniqueness enforced only in memory.
    const env = newEnv();
    const userId = await createUser(env);
    await createBudget(env, userId, "groceries", 100);
    env.reopen();
    expectErrorReply(await post(env, `/users/${userId}/budgets`, { category: "groceries", limitCents: 100 }), 409, "budget_exists");
  });

  test("user and spend ids continue after reopening instead of restarting at 1", async () => {
    // Catches: id counters held in memory, or ids derived from COUNT(*) / MAX(id)+1 on an emptied cache.
    const env = newEnv();
    const first = await userWithBudget(env);
    await createSpend(env, first, "groceries", 1, "2026-03-14T18:30:00Z");
    env.reopen();
    const second = await post(env, "/users", { name: "Bo", timeZone: "UTC" });
    expect((second.body as { id: number }).id).toBe(2);
    await createBudget(env, 2, "groceries", 10);
    const spend = await post(env, "/users/2/spends", { category: "groceries", amountCents: 1, spentAt: "2026-03-14T18:30:00Z" });
    expect((spend.body as { id: number }).id).toBe(2);
  });

  test("data survives several reopen cycles and new data joins the old", async () => {
    // Catches: each createApp truncating tables, or only the first reopen working.
    const env = newEnv(fixedClock("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env, { limitCents: 1000 });
    for (let round = 1; round <= 3; round += 1) {
      await createSpend(env, userId, "groceries", 100, `2026-03-0${round}T10:00:00Z`);
      env.reopen();
    }
    expect(((await summary(env, userId, "groceries")).body as SummaryBody).spentCents).toBe(300);
  });

  test("two sequential apps on the same file see each other's writes after close", async () => {
    // Catches: connections that never flush or keep the file locked after close().
    const env = newEnv();
    await createUser(env, "UTC", "First");
    env.reopen();
    await createUser(env, "UTC", "Second");
    env.reopen();
    const third = await post(env, "/users", { name: "Third", timeZone: "UTC" });
    expect((third.body as { id: number }).id).toBe(3);
  });

  test("a missing database file is created on first createApp", async () => {
    // Catches: failing when the file does not exist yet (readonly open, no create flag).
    const env = newEnv();
    expect(await Bun.file(env.dbPath).exists()).toBe(true);
    const reply = await post(env, "/users", { name: "Ada", timeZone: "UTC" });
    expect(reply.status).toBe(201);
  });
});

describe("in-memory database", () => {
  test("createApp accepts ':memory:' and serves requests", async () => {
    // Catches: treating dbPath as a file path to mkdir/stat, which breaks ':memory:'.
    const app = createApp({ dbPath: ":memory:", now: fixedClock("2026-03-14T12:00:00Z") });
    try {
      const response = await app.fetch(
        new Request("http://localhost/users", { method: "POST", body: JSON.stringify({ name: "Ada", timeZone: "UTC" }) }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 1, name: "Ada", timeZone: "UTC" });
    } finally {
      app.close();
    }
  });
});
