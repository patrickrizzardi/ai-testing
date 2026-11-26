import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, collectMismatches, createUser, expectErrorReply, newEnv, post, userWithBudget } from "./harness.ts";

afterEach(cleanupAll);

const VALID_BODY_BY_PATH_SUFFIX = {
  budgets: { category: "groceries", limitCents: 100 },
  spends: { category: "groceries", amountCents: 1, spentAt: "2026-03-14T18:30:00Z" },
};

describe("unknown routes", () => {
  const unknownPaths = [
    "/",
    "/nope",
    "/user",
    "/Users",
    "/users/",
    "/users/1",
    "/users/1/",
    "/users/1/budget",
    "/users/1/budgets/",
    "/users/1/budgets/groceries",
    "/users/1/budgets/groceries/",
    "/users/1/budgets/groceries/summary/",
    "/users/1/budgets/groceries/summary/extra",
    "/users/1/budgets//summary",
    "/users//budgets",
    "/users//spends",
    "/users/1/spends/",
    "/users/1/spends/1",
    "/users/1/budgets/a/b/summary",
    "/users/1/Budgets",
    "/users/1/budgets/groceries/Summary",
    "//users",
  ];

  test("unknown path answers 404 not_found for POST and GET", async () => {
    // Catches: prefix matching or lenient trailing-slash / extra-segment handling.
    const env = newEnv();
    await createUser(env);
    const mismatches = await collectMismatches(
      unknownPaths.flatMap((path) => ["GET", "POST"].map((method) => ({ method, path }))),
      async ({ method, path }) => {
        const reply = await env.send(method, path, method === "POST" ? { json: {} } : undefined);
        try {
          expectErrorReply(reply, 404, "not_found");
          return undefined;
        } catch (error) {
          return `got ${reply.status} ${reply.text} (${(error as Error).message.split("\n")[0]})`;
        }
      },
    );
    expect(mismatches).toEqual([]);
  });

  test("unknown path answers 404 for every other method, not 405", async () => {
    // Catches: checking the method before the path (order of checks step 1 vs 2).
    const env = newEnv();
    const mismatches = await collectMismatches(["PUT", "PATCH", "DELETE", "OPTIONS"], async (method) => {
      const reply = await env.send(method, "/nope");
      return reply.status === 404 && (reply.body as { code?: string })?.code === "not_found" ? undefined : `got ${reply.status} ${reply.text}`;
    });
    expect(mismatches).toEqual([]);
  });

  test("HEAD on an unknown path answers 404", async () => {
    // Catches: answering HEAD with 405 or 200 before the path check.
    const env = newEnv();
    const reply = await env.send("HEAD", "/nope");
    expect(reply.status).toBe(404);
  });

  test("query strings are ignored on every route", async () => {
    // Catches: matching the path with the query string still attached.
    const env = newEnv();
    const created = await post(env, "/users?x=1&y=2", { name: "Ada", timeZone: "UTC" });
    expect(created.status).toBe(201);
    const budget = await post(env, "/users/1/budgets?q", { category: "groceries", limitCents: 100 });
    expect(budget.status).toBe(201);
    const spend = await post(env, "/users/1/spends?", VALID_BODY_BY_PATH_SUFFIX.spends);
    expect(spend.status).toBe(201);
    const read = await env.send("GET", "/users/1/budgets/groceries/summary?month=2020-01&category=other");
    expect(read.status).toBe(200);
    expect((read.body as { category: string }).category).toBe("groceries");
  });

  test("path segments are compared as raw text without percent-decoding", async () => {
    // Catches: decodeURIComponent on userId or category (%31 would become 1).
    const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
    const userId = await userWithBudget(env);
    expect(userId).toBe(1);
    const encodedUser = await env.send("GET", "/users/%31/budgets/groceries/summary");
    expectErrorReply(encodedUser, 404, "not_found");
    const encodedCategory = await env.send("GET", "/users/1/budgets/gro%63eries/summary");
    expectErrorReply(encodedCategory, 404, "not_found");
    const encodedBudgetPost = await post(env, "/users/%31/budgets", { category: "other", limitCents: 5 });
    expectErrorReply(encodedBudgetPost, 404, "not_found");
  });
});

describe("method not allowed", () => {
  const postOnlyPaths = ["/users", "/users/1/budgets", "/users/1/spends"];

  test("non-POST methods on POST paths answer 405 method_not_allowed", async () => {
    // Catches: a router that returns 404 or 200 for GET/PUT/PATCH/DELETE/OPTIONS on a known path.
    const env = newEnv();
    await createUser(env);
    const mismatches = await collectMismatches(
      postOnlyPaths.flatMap((path) => ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"].map((method) => ({ method, path }))),
      async ({ method, path }) => {
        const reply = await env.send(method, path);
        try {
          expectErrorReply(reply, 405, "method_not_allowed");
          return undefined;
        } catch {
          return `got ${reply.status} ${reply.text}`;
        }
      },
    );
    expect(mismatches).toEqual([]);
  });

  test("non-GET methods on the summary path answer 405 method_not_allowed", async () => {
    // Catches: accepting POST (or anything but GET) on the summary route.
    const env = newEnv();
    await userWithBudget(env);
    const mismatches = await collectMismatches(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"], async (method) => {
      const reply = await env.send(method, "/users/1/budgets/groceries/summary", method === "POST" ? { json: {} } : undefined);
      try {
        expectErrorReply(reply, 405, "method_not_allowed");
        return undefined;
      } catch {
        return `got ${reply.status} ${reply.text}`;
      }
    });
    expect(mismatches).toEqual([]);
  });

  test("HEAD on known paths answers 405", async () => {
    // Catches: the runtime or router auto-answering HEAD like GET.
    const env = newEnv();
    await userWithBudget(env);
    const mismatches = await collectMismatches(
      ["/users", "/users/1/budgets", "/users/1/spends", "/users/1/budgets/groceries/summary"],
      async (path) => {
        const reply = await env.send("HEAD", path);
        return reply.status === 405 ? undefined : `got ${reply.status}`;
      },
    );
    expect(mismatches).toEqual([]);
  });

  test("method check comes before the user check", async () => {
    // Catches: looking up the user before checking the method (order of checks step 2 before 3).
    const env = newEnv();
    const mismatches = await collectMismatches(
      [
        { method: "GET", path: "/users/999/budgets" },
        { method: "PUT", path: "/users/999/spends" },
        { method: "DELETE", path: "/users/abc/budgets" },
        { method: "POST", path: "/users/999/budgets/groceries/summary" },
        { method: "PATCH", path: "/users/0/budgets/Not_A_Category/summary" },
      ],
      async ({ method, path }) => {
        const reply = await env.send(method, path);
        return reply.status === 405 && (reply.body as { code?: string })?.code === "method_not_allowed" ? undefined : `got ${reply.status} ${reply.text}`;
      },
    );
    expect(mismatches).toEqual([]);
  });
});

describe("userId in the path", () => {
  const namesNoUser = [
    "abc",
    "0",
    "-1",
    "+1",
    "01",
    "001",
    "1.5",
    "1.0",
    "1e0",
    "1abc",
    "0x1",
    "1.",
    "%31",
    "9007199254740992",
    "99999999999999999999",
    "999",
  ];

  test("userId that is not a plain positive decimal integer names no user (404 not_found)", async () => {
    // Catches: parseInt/Number/parseFloat leniency ("1abc", "01", "1e0", "0x1", "+1" all reach user 1).
    const env = newEnv();
    const userId = await createUser(env);
    expect(userId).toBe(1);
    const mismatches = await collectMismatches(
      namesNoUser.flatMap((name) => [
        { method: "POST", path: `/users/${name}/budgets`, json: VALID_BODY_BY_PATH_SUFFIX.budgets },
        { method: "POST", path: `/users/${name}/spends`, json: VALID_BODY_BY_PATH_SUFFIX.spends },
        { method: "GET", path: `/users/${name}/budgets/groceries/summary`, json: undefined },
      ]),
      async ({ method, path, json }) => {
        const reply = await env.send(method, path, json === undefined ? undefined : { json });
        try {
          expectErrorReply(reply, 404, "not_found");
          return undefined;
        } catch {
          return `got ${reply.status} ${reply.text}`;
        }
      },
    );
    expect(mismatches).toEqual([]);
  });

  test("user check comes before body validation", async () => {
    // Catches: validating the body before looking up the user (order of checks step 3 before 4).
    const env = newEnv();
    const missingUserBodies = [
      { raw: "" },
      { raw: "{not json" },
      { raw: "[]" },
      { json: { category: "NOPE", limitCents: -1 } },
    ];
    const mismatches = await collectMismatches(
      ["budgets", "spends"].flatMap((suffix) => missingUserBodies.map((payload) => ({ suffix, payload }))),
      async ({ suffix, payload }) => {
        const reply = await env.send("POST", `/users/999/${suffix}`, payload);
        return reply.status === 404 && (reply.body as { code?: string })?.code === "not_found" ? undefined : `got ${reply.status} ${reply.text}`;
      },
    );
    expect(mismatches).toEqual([]);
  });

  test("a user's data is reachable only through its own id", async () => {
    // Catches: ignoring the userId in the path (everything lands on the first user).
    const env = newEnv();
    await createUser(env);
    const second = await createUser(env);
    expect(second).toBe(2);
    expect((await post(env, "/users/2/budgets", { category: "rent", limitCents: 10 })).status).toBe(201);
    const onFirst = await env.send("GET", "/users/1/budgets/rent/summary");
    expectErrorReply(onFirst, 404, "not_found");
    const onSecond = await env.send("GET", "/users/2/budgets/rent/summary");
    expect(onSecond.status).toBe(200);
  });
});
