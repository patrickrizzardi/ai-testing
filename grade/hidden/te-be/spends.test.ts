import { afterEach, describe, expect, test } from "bun:test";
import {
  ACCEPTED_INTEGER_LITERALS,
  REJECTED_INTEGER_LITERALS,
  bodyMismatches,
  cleanupAll,
  collectMismatches,
  createBudget,
  createUser,
  expectErrorReply,
  newEnv,
  post,
  rawWithLiteral,
  summary,
  userWithBudget,
  withField,
  type BodyCase,
  type SummaryBody,
} from "./harness.ts";

afterEach(cleanupAll);

const validSpend = { category: "groceries", amountCents: 1250, spentAt: "2026-03-14T18:30:00+01:00" };

describe("POST /users/{userId}/spends: spentAt", () => {
  test("valid RFC 3339 timestamps with Z or numeric offsets are accepted and echoed exactly", async () => {
    // Catches: normalising spentAt to UTC/ISO instead of returning it as sent; rejecting fractions of 1-9 digits.
    const env = newEnv();
    const userId = await userWithBudget(env);
    const accepted = [
      "2026-03-14T18:30:00+01:00",
      "2026-03-14T18:30:00Z",
      "2026-03-14T18:30:00-00:00",
      "2026-03-14T18:30:00+00:00",
      "2026-03-14T18:30:00.1Z",
      "2026-03-14T18:30:00.123Z",
      "2026-03-14T18:30:00.123456789Z",
      "2026-03-14T18:30:00.50+05:30",
      "2026-12-31T23:59:59-23:59",
      "2026-01-01T00:00:00+23:59",
      "2026-01-31T00:00:00Z",
      "2026-04-30T12:00:00Z",
      "1999-12-31T23:59:59Z",
      "2100-01-01T00:00:00Z",
      "2030-06-15T12:00:00Z",
    ];
    const mismatches = await collectMismatches(accepted, async (spentAt) => {
      const reply = await post(env, `/users/${userId}/spends`, { ...validSpend, spentAt });
      if (reply.status !== 201) return `expected 201, got ${reply.status} ${reply.text}`;
      return (reply.body as { spentAt?: string }).spentAt === spentAt ? undefined : `echoed ${reply.text}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("leap days exist only in leap years (2024, 2028, 2000 yes; 2026, 2100, 1900 no)", async () => {
    // Catches: allowing Feb 29 in every year, or the century rule (2100 and 1900 are not leap, 2000 is).
    const env = newEnv();
    const userId = await userWithBudget(env);
    const accepted = ["2024-02-29T12:00:00Z", "2028-02-29T12:00:00Z", "2000-02-29T12:00:00Z", "2026-02-28T23:59:59Z", "2100-02-28T12:00:00Z"];
    const rejected = ["2026-02-29T12:00:00Z", "2025-02-29T12:00:00Z", "2100-02-29T12:00:00Z", "1900-02-29T12:00:00Z", "2024-02-30T12:00:00Z", "2026-02-30T12:00:00Z"];
    const cases: BodyCase[] = accepted.map((spentAt) => ({ label: spentAt, json: { ...validSpend, spentAt } }));
    expect(await bodyMismatches(env, `/users/${userId}/spends`, cases, "accepted")).toEqual([]);
    const badCases: BodyCase[] = rejected.map((spentAt) => ({ label: spentAt, json: { ...validSpend, spentAt } }));
    expect(await bodyMismatches(env, `/users/${userId}/spends`, badCases, "rejected")).toEqual([]);
  });

  test("days beyond a month's length and month 00 or 13 are rejected", async () => {
    // Catches: using a flat 31-day check, or Date.parse rolling over (2026-04-31 becomes May 1).
    const env = newEnv();
    const userId = await userWithBudget(env);
    const rejected = [
      "2026-04-31T12:00:00Z",
      "2026-06-31T12:00:00Z",
      "2026-09-31T12:00:00Z",
      "2026-11-31T12:00:00Z",
      "2026-01-32T12:00:00Z",
      "2026-03-00T12:00:00Z",
      "2026-00-10T12:00:00Z",
      "2026-13-10T12:00:00Z",
      "2026-99-99T12:00:00Z",
    ];
    const cases: BodyCase[] = rejected.map((spentAt) => ({ label: spentAt, json: { ...validSpend, spentAt } }));
    expect(await bodyMismatches(env, `/users/${userId}/spends`, cases, "rejected")).toEqual([]);
  });

  test("hour 24, minute 60, second 60 (no leap second) and bad offsets are rejected", async () => {
    // Catches: accepting 24:00:00 or 23:59:60 as JS Date sometimes does; offset limits off by one.
    const env = newEnv();
    const userId = await userWithBudget(env);
    const rejected = [
      "2026-03-14T24:00:00Z",
      "2026-03-14T25:00:00Z",
      "2026-03-14T18:60:00Z",
      "2026-03-14T18:30:60Z",
      "2026-03-14T23:59:60Z",
      "2026-03-14T18:30:61Z",
      "2026-03-14T18:30:00+24:00",
      "2026-03-14T18:30:00-24:00",
      "2026-03-14T18:30:00+23:60",
      "2026-03-14T18:30:00+01:99",
      "2026-03-14T18:30:00+99:00",
    ];
    const cases: BodyCase[] = rejected.map((spentAt) => ({ label: spentAt, json: { ...validSpend, spentAt } }));
    expect(await bodyMismatches(env, `/users/${userId}/spends`, cases, "rejected")).toEqual([]);
  });

  test("timestamps in the wrong shape are rejected (no offset, lowercase t or z, space, missing parts)", async () => {
    // Catches: delegating to Date.parse / new Date(), which accepts all of these.
    const env = newEnv();
    const userId = await userWithBudget(env);
    const rejected = [
      "2026-03-14T18:30:00",
      "2026-03-14T18:30:00.123",
      "2026-03-14 18:30:00Z",
      "2026-03-14t18:30:00Z",
      "2026-03-14T18:30:00z",
      "2026-03-14T18:30Z",
      "2026-03-14T18Z",
      "2026-03-14Z",
      "2026-03-14",
      "18:30:00Z",
      "2026-03-14T18:30:00.Z",
      "2026-03-14T18:30:00.1234567890Z",
      "2026-03-14T18:30:00+0100",
      "2026-03-14T18:30:00+01",
      "2026-03-14T18:30:00+1:00",
      "2026-03-14T18:30:00 +01:00",
      "2026-03-14T18:30:00Z+01:00",
      "2026-03-14T18:30:00ZZ",
      "2026-03-14T18:30:00+01:00:00",
      "2026-3-14T18:30:00Z",
      "2026-03-4T18:30:00Z",
      "26-03-14T18:30:00Z",
      "02026-03-14T18:30:00Z",
      "2026/03/14T18:30:00Z",
      "20260314T183000Z",
      " 2026-03-14T18:30:00Z",
      "2026-03-14T18:30:00Z ",
      "2026-03-14T18:30:00Z\n",
      "٢٠٢٦-03-14T18:30:00Z",
      "+002026-03-14T18:30:00Z",
      "Sat, 14 Mar 2026 18:30:00 GMT",
      "March 14, 2026 18:30:00 UTC",
      "1773513000",
      "",
    ];
    const cases: BodyCase[] = rejected.map((spentAt) => ({ label: JSON.stringify(spentAt), json: { ...validSpend, spentAt } }));
    expect(await bodyMismatches(env, `/users/${userId}/spends`, cases, "rejected")).toEqual([]);
  });

  test("spentAt that is missing, null or not a string is rejected", async () => {
    // Catches: accepting epoch numbers or defaulting a missing spentAt to now().
    const env = newEnv();
    const userId = await userWithBudget(env);
    const cases: BodyCase[] = [
      { label: "missing", json: withField(validSpend, "spentAt", undefined) },
      { label: "null", json: withField(validSpend, "spentAt", null) },
      { label: "epoch number", json: withField(validSpend, "spentAt", 1773513000) },
      { label: "epoch ms", json: withField(validSpend, "spentAt", 1773513000000) },
      { label: "array", json: withField(validSpend, "spentAt", ["2026-03-14T18:30:00Z"]) },
      { label: "object", json: withField(validSpend, "spentAt", {}) },
    ];
    expect(await bodyMismatches(env, `/users/${userId}/spends`, cases, "rejected")).toEqual([]);
  });

  test("spentAt may be far in the past or the future: it is not checked against now", async () => {
    // Catches: rejecting future spends or spends older than a window.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    const cases: BodyCase[] = ["1970-01-01T00:00:00Z", "2001-09-09T01:46:40Z", "2026-03-14T12:00:01Z", "2099-12-31T23:59:59Z"].map((spentAt) => ({
      label: spentAt,
      json: { ...validSpend, spentAt },
    }));
    expect(await bodyMismatches(env, `/users/${userId}/spends`, cases, "accepted")).toEqual([]);
  });
});

describe("POST /users/{userId}/spends: amountCents and category", () => {
  test("whole numbers 1 to 1,000,000,000 are accepted, including 5.0 and 5e0 forms", async () => {
    // Catches: integer checks on raw text, rejecting 5.0/5e0, an upper bound of 2^31-1 or 999999999.
    const env = newEnv();
    const userId = await userWithBudget(env);
    const mismatches = await collectMismatches(ACCEPTED_INTEGER_LITERALS, async ({ literal, value }) => {
      const reply = await env.send("POST", `/users/${userId}/spends`, { raw: rawWithLiteral(validSpend, "amountCents", literal) });
      if (reply.status !== 201) return `expected 201, got ${reply.status} ${reply.text}`;
      return (reply.body as { amountCents?: unknown }).amountCents === value ? undefined : `echoed ${reply.text}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("amount 0, negatives, above 1,000,000,000, fractions, strings and non-numbers are rejected", async () => {
    // Catches: missing bounds, off-by-one at 1 and 1e9, accepting "5" strings, booleans or null.
    const env = newEnv();
    const userId = await userWithBudget(env);
    const cases: BodyCase[] = REJECTED_INTEGER_LITERALS.map((literal) => ({ label: literal, raw: rawWithLiteral(validSpend, "amountCents", literal) }));
    cases.push({ label: "missing", json: withField(validSpend, "amountCents", undefined) });
    expect(await bodyMismatches(env, `/users/${userId}/spends`, cases, "rejected")).toEqual([]);
  });

  test("category with 0 or 51 characters, bad characters or a non-string is rejected", async () => {
    // Catches: skipping the category format check on spends (a bad format must be 400, not 422).
    const env = newEnv();
    const userId = await userWithBudget(env);
    const badCategories: unknown[] = ["", "x".repeat(51), "Groceries", "a_b", "a b", "é", "a\n", 5, null, ["groceries"], true];
    const cases: BodyCase[] = badCategories.map((category) => ({ label: JSON.stringify(category).slice(0, 20), json: withField(validSpend, "category", category) }));
    cases.push({ label: "missing", json: withField(validSpend, "category", undefined) });
    expect(await bodyMismatches(env, `/users/${userId}/spends`, cases, "rejected")).toEqual([]);
  });

  test("a 50-character and a 1-character category work end to end", async () => {
    // Catches: category length limits enforced differently on budgets and spends.
    const env = newEnv();
    const userId = await createUser(env);
    for (const category of ["a", "b".repeat(50)]) {
      await createBudget(env, userId, category, 100);
      const spend = await post(env, `/users/${userId}/spends`, { ...validSpend, category });
      expect(spend.status).toBe(201);
      expect((spend.body as { category: string }).category).toBe(category);
    }
  });
});

describe("POST /users/{userId}/spends: business rules and ids", () => {
  test("spend in a category without a budget answers 422 no_budget", async () => {
    // Catches: auto-creating the budget, or answering 404/400 for the missing budget.
    const env = newEnv();
    const userId = await userWithBudget(env);
    const reply = await post(env, `/users/${userId}/spends`, { ...validSpend, category: "rent" });
    expectErrorReply(reply, 422, "no_budget");
  });

  test("another user's budget does not allow a spend: no_budget is per user", async () => {
    // Catches: looking the budget up by category alone.
    const env = newEnv();
    await userWithBudget(env);
    const stranger = await createUser(env);
    const reply = await post(env, `/users/${stranger}/spends`, validSpend);
    expectErrorReply(reply, 422, "no_budget");
  });

  test("a 422 spend stores nothing and does not use up a spend id", async () => {
    // Catches: inserting the spend before the budget check, or consuming an autoincrement id.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    expectErrorReply(await post(env, `/users/${userId}/spends`, { ...validSpend, category: "rent" }), 422, "no_budget");
    await createBudget(env, userId, "rent", 9999);
    const read = await summary(env, userId, "rent");
    expect((read.body as SummaryBody).spentCents).toBe(0);
    const first = await post(env, `/users/${userId}/spends`, validSpend);
    expect((first.body as { id: number }).id).toBe(1);
  });

  test("a 400 spend stores nothing and does not use up a spend id", async () => {
    // Catches: partial writes or id consumption before validation completes.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    expectErrorReply(await post(env, `/users/${userId}/spends`, { ...validSpend, amountCents: 0 }), 400, "invalid_input");
    const first = await post(env, `/users/${userId}/spends`, validSpend);
    expect((first.body as { id: number }).id).toBe(1);
    const read = await summary(env, userId, "groceries");
    expect((read.body as SummaryBody).spentCents).toBe(1250);
  });

  test("validation runs before the budget check: a bad body with no budget is 400, not 422", async () => {
    // Catches: checking the budget before validating the body (order of checks step 4 before 5).
    const env = newEnv();
    const userId = await createUser(env);
    const mismatches = await collectMismatches(
      [
        { ...validSpend, amountCents: -5 },
        { ...validSpend, spentAt: "2026-02-30T00:00:00Z" },
        { ...validSpend, category: "Bad_Category" },
        { category: "groceries" },
      ],
      async (body) => {
        const reply = await post(env, `/users/${userId}/spends`, body);
        return reply.status === 400 && (reply.body as { code?: string })?.code === "invalid_input" ? undefined : `got ${reply.status} ${reply.text}`;
      },
    );
    expect(mismatches).toEqual([]);
  });

  test("spend ids are one sequence across all users: 1, 2, 3 in creation order", async () => {
    // Catches: per-user spend numbering, or sharing the user id sequence.
    const env = newEnv();
    const first = await userWithBudget(env);
    const second = await userWithBudget(env);
    const ids: unknown[] = [];
    for (const userId of [first, second, first]) {
      ids.push(((await post(env, `/users/${userId}/spends`, validSpend)).body as { id: number }).id);
    }
    expect(ids).toEqual([1, 2, 3]);
  });

  test("users and spends have independent id sequences", async () => {
    // Catches: one shared counter for users and spends.
    const env = newEnv();
    for (let count = 0; count < 3; count += 1) await createUser(env);
    await createBudget(env, 3, "groceries", 100);
    const spend = await post(env, "/users/3/spends", validSpend);
    expect((spend.body as { id: number }).id).toBe(1);
    const user = await post(env, "/users", { name: "next", timeZone: "UTC" });
    expect((user.body as { id: number }).id).toBe(4);
  });
});
