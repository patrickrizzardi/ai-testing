import { afterEach, describe, expect, test } from "bun:test";
import {
  ACCEPTED_INTEGER_LITERALS,
  REJECTED_INTEGER_LITERALS,
  bodyMismatches,
  cleanupAll,
  collectMismatches,
  createUser,
  expectErrorReply,
  illFormedCases,
  newEnv,
  post,
  rawWithLiteral,
  storedStringsWithReplacementChar,
  summary,
  withField,
  type BodyCase,
} from "./harness.ts";

afterEach(cleanupAll);

const validBudget = { category: "groceries", limitCents: 50000 };

describe("POST /users/{userId}/budgets: category", () => {
  test("category of 1 to 50 characters from a-z, 0-9 and hyphen is accepted", async () => {
    // Catches: off-by-one at 1 and 50, rejecting digits or hyphens, rejecting a lone "-".
    const env = newEnv();
    const userId = await createUser(env);
    const accepted = ["a", "z", "0", "9", "-", "a-b", "-a-", "--", "road-trip-2026", "x".repeat(50), "0".repeat(50)];
    const cases: BodyCase[] = accepted.map((category) => ({ label: category, json: withField(validBudget, "category", category) }));
    expect(await bodyMismatches(env, `/users/${userId}/budgets`, cases, "accepted")).toEqual([]);
  });

  test("category of 0 or 51 characters is rejected with 400 invalid_input", async () => {
    // Catches: missing length bounds or an off-by-one at 50.
    const env = newEnv();
    const userId = await createUser(env);
    const cases: BodyCase[] = ["", "x".repeat(51), "x".repeat(200)].map((category) => ({
      label: category.slice(0, 8),
      json: withField(validBudget, "category", category),
    }));
    expect(await bodyMismatches(env, `/users/${userId}/budgets`, cases, "rejected")).toEqual([]);
  });

  test("category with characters outside a-z, 0-9 and hyphen is rejected", async () => {
    // Catches: an unanchored or case-insensitive regex; allowing underscore, space, dot, slash, uppercase, non-ASCII.
    const env = newEnv();
    const userId = await createUser(env);
    const bad = ["Groceries", "GROCERIES", "gRoceries", "a b", " a", "a ", "a_b", "a.b", "a/b", "a+b", "é", "café", "日本", "a\n", "\na", "a\tb", "😀", "a%20b", "a?b", "a#b"];
    const cases: BodyCase[] = bad.map((category) => ({ label: JSON.stringify(category), json: withField(validBudget, "category", category) }));
    expect(await bodyMismatches(env, `/users/${userId}/budgets`, cases, "rejected")).toEqual([]);
  });

  test("category that is missing, null or not a string is rejected", async () => {
    // Catches: coercing numbers to strings ("5"), defaulting a missing category.
    const env = newEnv();
    const userId = await createUser(env);
    const cases: BodyCase[] = [
      { label: "missing", json: withField(validBudget, "category", undefined) },
      { label: "null", json: withField(validBudget, "category", null) },
      { label: "number", json: withField(validBudget, "category", 5) },
      { label: "boolean", json: withField(validBudget, "category", false) },
      { label: "array", json: withField(validBudget, "category", ["groceries"]) },
    ];
    expect(await bodyMismatches(env, `/users/${userId}/budgets`, cases, "rejected")).toEqual([]);
  });
});

describe("POST /users/{userId}/budgets: well-formed Unicode", () => {
  test("a category with an unpaired surrogate is rejected with 400 invalid_input and nothing is stored", async () => {
    // Catches: a lone surrogate slipping through category validation and being stored as U+FFFD. Tier: High (untrusted input, data integrity).
    const env = newEnv();
    const userId = await createUser(env);
    expect(await bodyMismatches(env, `/users/${userId}/budgets`, illFormedCases(validBudget, "category"), "rejected")).toEqual([]);
    expect(storedStringsWithReplacementChar(env)).toEqual([]);
  });
});

describe("POST /users/{userId}/budgets: limitCents", () => {
  test("whole numbers 1 to 1,000,000,000 are accepted, including 5.0 and 5e0 forms", async () => {
    // Catches: Number.isInteger on a regex of the raw text, rejecting 5.0 / 5e0, or an upper bound of 2^31-1 or 999999999.
    const env = newEnv();
    const userId = await createUser(env);
    const mismatches = await collectMismatches(ACCEPTED_INTEGER_LITERALS, async ({ literal, value }) => {
      const category = `c${literal.replace(/[^0-9a-z]/gi, "-").toLowerCase()}`.slice(0, 50);
      const raw = rawWithLiteral({ category, limitCents: 0 }, "limitCents", literal);
      const reply = await env.send("POST", `/users/${userId}/budgets`, { raw });
      if (reply.status !== 201) return `expected 201, got ${reply.status} ${reply.text}`;
      return (reply.body as { limitCents?: unknown }).limitCents === value ? undefined : `echoed ${reply.text}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("limit 0, negatives, above 1,000,000,000, fractions, strings and non-numbers are rejected", async () => {
    // Catches: missing bounds, off-by-one at 1 and 1e9, accepting fractions, "5" strings or booleans.
    const env = newEnv();
    const userId = await createUser(env);
    const cases: BodyCase[] = REJECTED_INTEGER_LITERALS.map((literal) => ({ label: literal, raw: rawWithLiteral(validBudget, "limitCents", literal) }));
    cases.push({ label: "missing", json: withField(validBudget, "limitCents", undefined) });
    expect(await bodyMismatches(env, `/users/${userId}/budgets`, cases, "rejected")).toEqual([]);
  });
});

describe("POST /users/{userId}/budgets: uniqueness and isolation", () => {
  test("second budget for the same user and category answers 409 budget_exists", async () => {
    // Catches: no uniqueness check, or answering 400/422/500 for the duplicate.
    const env = newEnv();
    const userId = await createUser(env);
    expect((await post(env, `/users/${userId}/budgets`, validBudget)).status).toBe(201);
    const duplicate = await post(env, `/users/${userId}/budgets`, validBudget);
    expectErrorReply(duplicate, 409, "budget_exists");
  });

  test("a duplicate with a different limit is rejected and does not change the stored limit", async () => {
    // Catches: upsert semantics (INSERT OR REPLACE) that silently change the limit.
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await createUser(env);
    await post(env, `/users/${userId}/budgets`, validBudget);
    const duplicate = await post(env, `/users/${userId}/budgets`, { category: "groceries", limitCents: 1 });
    expectErrorReply(duplicate, 409, "budget_exists");
    const read = await summary(env, userId, "groceries");
    expect((read.body as { limitCents: number }).limitCents).toBe(50000);
  });

  test("different users may each have a budget in the same category", async () => {
    // Catches: UNIQUE(category) instead of UNIQUE(userId, category).
    const env = newEnv();
    const first = await createUser(env);
    const second = await createUser(env);
    expect((await post(env, `/users/${first}/budgets`, validBudget)).status).toBe(201);
    const reply = await post(env, `/users/${second}/budgets`, { category: "groceries", limitCents: 70 });
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ category: "groceries", limitCents: 70 });
  });

  test("one user may have budgets in several categories", async () => {
    // Catches: UNIQUE(userId) alone.
    const env = newEnv();
    const userId = await createUser(env);
    const statuses = [];
    for (const category of ["groceries", "rent", "fun-2"]) statuses.push((await post(env, `/users/${userId}/budgets`, { category, limitCents: 10 })).status);
    expect(statuses).toEqual([201, 201, 201]);
  });

  test("validation runs before the duplicate check: a bad body for an existing budget is 400", async () => {
    // Catches: checking for a duplicate before validating (order of checks step 4 before 5).
    const env = newEnv();
    const userId = await createUser(env);
    await post(env, `/users/${userId}/budgets`, validBudget);
    const reply = await post(env, `/users/${userId}/budgets`, { category: "groceries", limitCents: 0 });
    expectErrorReply(reply, 400, "invalid_input");
  });
});
