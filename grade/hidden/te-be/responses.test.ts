import { afterEach, expect, test } from "bun:test";
import { cleanupAll, createUser, expectErrorReply, newEnv, post, postRaw, userWithBudget } from "./harness.ts";

afterEach(cleanupAll);

test("success and error responses all carry Content-Type application/json", async () => {
  // Catches: Response.json used for success but a plain-text or empty error response.
  const env = newEnv(() => new Date("2026-03-14T12:00:00Z"));
  await userWithBudget(env);
  const replies = [
    await post(env, "/users", { name: "Bo", timeZone: "UTC" }),
    await post(env, "/users", {}),
    await env.send("GET", "/users"),
    await env.send("GET", "/nope"),
    await post(env, "/users/1/budgets", { category: "groceries", limitCents: 5 }),
    await post(env, "/users/1/spends", { category: "none", amountCents: 5, spentAt: "2026-03-14T18:30:00Z" }),
    await env.send("GET", "/users/1/budgets/groceries/summary"),
    await env.send("GET", "/users/9/budgets/groceries/summary"),
  ];
  for (const reply of replies) {
    expect(reply.contentType?.split(";")[0]?.trim().toLowerCase()).toBe("application/json");
  }
});

test("201 bodies contain exactly the documented keys", async () => {
  // Catches: leaking storage columns (userId, createdAt) into responses.
  const env = newEnv();
  const user = await post(env, "/users", { name: "Ada", timeZone: "Europe/Paris", extra: "ignored" });
  expect(user.status).toBe(201);
  expect(user.body).toEqual({ id: 1, name: "Ada", timeZone: "Europe/Paris" });
  const budget = await post(env, "/users/1/budgets", { category: "groceries", limitCents: 50000, note: "x" });
  expect(budget.status).toBe(201);
  expect(budget.body).toEqual({ category: "groceries", limitCents: 50000 });
  const spend = await post(env, "/users/1/spends", {
    category: "groceries",
    amountCents: 1250,
    spentAt: "2026-03-14T18:30:00+01:00",
    id: 77,
  });
  expect(spend.status).toBe(201);
  expect(spend.body).toEqual({ id: 1, category: "groceries", amountCents: 1250, spentAt: "2026-03-14T18:30:00+01:00" });
});

test("request bodies are parsed as JSON whatever the Content-Type header says", async () => {
  // Catches: rejecting or ignoring bodies unless Content-Type is application/json.
  const env = newEnv();
  const mismatches: string[] = [];
  const headerSets: Record<string, string>[] = [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, {}];
  for (const headers of headerSets) {
    const reply = await env.send("POST", "/users", { raw: JSON.stringify({ name: "Ada", timeZone: "UTC" }), headers });
    if (reply.status !== 201) mismatches.push(`${JSON.stringify(headers)} -> ${reply.status} ${reply.text}`);
  }
  expect(mismatches).toEqual([]);
});

test("unknown request fields are ignored, including id on POST /users", async () => {
  // Catches: strict schemas that reject extras, or letting a client choose the id.
  const env = newEnv();
  const reply = await post(env, "/users", { id: 50, name: "Ada", timeZone: "UTC", admin: true, nested: { a: [1] } });
  expect(reply.status).toBe(201);
  expect(reply.body).toEqual({ id: 1, name: "Ada", timeZone: "UTC" });
});

test("fetch resolves with 400 for a body that is not valid UTF-8", async () => {
  // Catches: an uncaught decoding error turning into a rejection or 500.
  const env = newEnv();
  await createUser(env);
  const reply = await postRaw(env, "/users", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
  expectErrorReply(reply, 400, "invalid_input");
});

test("body that is not a JSON object answers 400 invalid_input on every POST route", async () => {
  // Catches: malformed JSON surfacing as 500, or arrays/null/primitives treated as empty objects.
  const env = newEnv();
  const userId = await createUser(env);
  const badBodies = ["", "   ", "{", "{\"name\":", "not json", "[]", "[{\"name\":\"a\"}]", "\"text\"", "123", "true", "null", "{'name':'a'}", "{\"name\":\"a\",}"];
  const mismatches: string[] = [];
  for (const path of ["/users", `/users/${userId}/budgets`, `/users/${userId}/spends`]) {
    for (const raw of badBodies) {
      const reply = await postRaw(env, path, raw);
      try {
        expectErrorReply(reply, 400, "invalid_input");
      } catch {
        mismatches.push(`${path} ${JSON.stringify(raw)} -> ${reply.status} ${reply.text}`);
      }
    }
    const noBody = await env.send("POST", path);
    if (noBody.status !== 400) mismatches.push(`${path} with no body -> ${noBody.status}`);
  }
  expect(mismatches).toEqual([]);
});

test("a rejected request leaves ids untouched: the next user is still id 1", async () => {
  // Catches: consuming an autoincrement id (or inserting a row) before validation finishes.
  const env = newEnv();
  expect((await post(env, "/users", { name: "", timeZone: "UTC" })).status).toBe(400);
  expect((await postRaw(env, "/users", "{")).status).toBe(400);
  const reply = await post(env, "/users", { name: "Ada", timeZone: "UTC" });
  expect(reply.body).toEqual({ id: 1, name: "Ada", timeZone: "UTC" });
});
