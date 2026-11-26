import { afterEach, describe, expect, test } from "bun:test";
import { bodyMismatches, cleanupAll, newEnv, post, rawWithLiteral, withField, type BodyCase } from "./harness.ts";

afterEach(cleanupAll);

const validUser = { name: "Ada", timeZone: "Europe/Paris" };

describe("POST /users: name", () => {
  test("name length 1 to 100 code points is accepted, returned exactly as sent", async () => {
    // Catches: off-by-one at 1 and 100, trimming, case folding.
    const env = newEnv();
    const names = ["a", "x".repeat(100), "  Ada  ", "ADA lovelace", " ", "Zoë 日本語"];
    const mismatches: string[] = [];
    for (const name of names) {
      const reply = await post(env, "/users", { name, timeZone: "UTC" });
      if (reply.status !== 201 || (reply.body as { name?: string }).name !== name) mismatches.push(`${JSON.stringify(name)} -> ${reply.status} ${reply.text}`);
    }
    expect(mismatches).toEqual([]);
  });

  test("name of 0 or 101 characters is rejected with 400 invalid_input", async () => {
    // Catches: <= / < confusion on the 100 limit; accepting the empty string.
    const env = newEnv();
    const cases: BodyCase[] = [
      { label: "empty", json: withField(validUser, "name", "") },
      { label: "101 chars", json: withField(validUser, "name", "x".repeat(101)) },
      { label: "1000 chars", json: withField(validUser, "name", "y".repeat(1000)) },
    ];
    expect(await bodyMismatches(env, "/users", cases, "rejected")).toEqual([]);
  });

  test("name length is counted in code points, not UTF-16 units", async () => {
    // Catches: using String.length (an astral character counts 2, so 100 emoji would be rejected).
    const env = newEnv();
    const hundredEmoji = "😀".repeat(100);
    const accepted = await post(env, "/users", { name: hundredEmoji, timeZone: "UTC" });
    expect(accepted.status).toBe(201);
    expect((accepted.body as { name: string }).name).toBe(hundredEmoji);
    const rejected = await bodyMismatches(env, "/users", [{ label: "101 emoji", json: withField(validUser, "name", "😀".repeat(101)) }], "rejected");
    expect(rejected).toEqual([]);
  });

  test("name that is missing, null or not a string is rejected", async () => {
    // Catches: coercing numbers or arrays to strings; treating null as absent-but-ok.
    const env = newEnv();
    const cases: BodyCase[] = [
      { label: "missing", json: withField(validUser, "name", undefined) },
      { label: "null", json: withField(validUser, "name", null) },
      { label: "number", json: withField(validUser, "name", 5) },
      { label: "boolean", json: withField(validUser, "name", true) },
      { label: "array", json: withField(validUser, "name", ["Ada"]) },
      { label: "object", json: withField(validUser, "name", { first: "Ada" }) },
    ];
    expect(await bodyMismatches(env, "/users", cases, "rejected")).toEqual([]);
  });

  test("names need not be unique", async () => {
    // Catches: a UNIQUE constraint on name.
    const env = newEnv();
    const first = await post(env, "/users", validUser);
    const second = await post(env, "/users", validUser);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect([(first.body as { id: number }).id, (second.body as { id: number }).id]).toEqual([1, 2]);
  });
});

describe("POST /users: timeZone", () => {
  test("IANA zone names are accepted and returned exactly as sent", async () => {
    // Catches: a hard-coded zone list, or normalising the zone string.
    const env = newEnv();
    const zones = ["UTC", "Europe/Paris", "America/New_York", "Asia/Kolkata", "Pacific/Auckland", "Etc/GMT+5", "America/Argentina/Buenos_Aires"];
    const mismatches: string[] = [];
    for (const timeZone of zones) {
      const reply = await post(env, "/users", { name: "Ada", timeZone });
      if (reply.status !== 201 || (reply.body as { timeZone?: string }).timeZone !== timeZone) mismatches.push(`${timeZone} -> ${reply.status} ${reply.text}`);
    }
    expect(mismatches).toEqual([]);
  });

  test("offset-style, empty and unknown zones are rejected with 400 invalid_input", async () => {
    // Catches: relying on Intl alone (Bun's Intl accepts "+02:00"); accepting "".
    const env = newEnv();
    const bad = ["", "+02:00", "-05:00", "+0200", "+02", "Mars/Base", "Europe/Paris ", " UTC", "Z", "local", "Europe/Atlantis"];
    const cases: BodyCase[] = bad.map((timeZone) => ({ label: timeZone, json: withField(validUser, "timeZone", timeZone) }));
    expect(await bodyMismatches(env, "/users", cases, "rejected")).toEqual([]);
  });

  test("timeZone that is missing, null or not a string is rejected", async () => {
    // Catches: defaulting a missing zone to UTC.
    const env = newEnv();
    const cases: BodyCase[] = [
      { label: "missing", json: withField(validUser, "timeZone", undefined) },
      { label: "null", json: withField(validUser, "timeZone", null) },
      { label: "number", json: withField(validUser, "timeZone", 2) },
      { label: "array", json: withField(validUser, "timeZone", ["UTC"]) },
    ];
    expect(await bodyMismatches(env, "/users", cases, "rejected")).toEqual([]);
  });

  test("zone names Intl.DateTimeFormat accepts are valid, whatever their letter case", async () => {
    // Catches: re-implementing validation with a case-sensitive list instead of the spec's Intl rule.
    const env = newEnv();
    const names = ["europe/paris", "utc", "Asia/Calcutta", "GMT"];
    const mismatches: string[] = [];
    for (const timeZone of names) {
      new Intl.DateTimeFormat(undefined, { timeZone });
      const reply = await post(env, "/users", { name: "Ada", timeZone });
      if (reply.status !== 201 || (reply.body as { timeZone?: string }).timeZone !== timeZone) mismatches.push(`${timeZone} -> ${reply.status} ${reply.text}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("POST /users: ids and body", () => {
  test("user ids are 1, 2, 3 in creation order", async () => {
    // Catches: ids that start at 0, are random, or are shared with another table's sequence.
    const env = newEnv();
    const ids: unknown[] = [];
    for (const name of ["a", "b", "c"]) ids.push(((await post(env, "/users", { name, timeZone: "UTC" })).body as { id: number }).id);
    expect(ids).toEqual([1, 2, 3]);
  });

  test("raw JSON with escapes round-trips the name", async () => {
    // Catches: double-decoding or re-escaping the stored string.
    const env = newEnv();
    const reply = await env.send("POST", "/users", { raw: rawWithLiteral(validUser, "name", '"line\\nbreak \\"q\\" \\u00e9"') });
    expect(reply.status).toBe(201);
    expect((reply.body as { name: string }).name).toBe('line\nbreak "q" é');
  });
});
