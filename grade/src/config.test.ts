import { describe, expect, test } from "bun:test";
import { loadTaskConfig, parseTaskConfig } from "./config.ts";

// High tier (validator). Bug caught: a typo in a task config silently dropping a gate or threshold.
describe("parseTaskConfig", () => {
  test("applies defaults: all gates, 60 tokens", () => {
    expect(parseTaskConfig({ entries: ["src/index.ts"] }, "c")).toEqual({
      ok: true,
      value: {
        entries: ["src/index.ts"],
        gates: ["duct-tape", "swallowed-error", "sql-injection", "duplication"],
        duplicationMinTokens: 60,
      },
    });
  });

  test("honours a gate subset (in canonical order) and a threshold", () => {
    expect(parseTaskConfig({ entries: ["a"], gates: ["duplication", "duct-tape"], duplication: { minTokens: 30 } }, "c")).toEqual({
      ok: true,
      value: { entries: ["a"], gates: ["duct-tape", "duplication"], duplicationMinTokens: 30 },
    });
  });

  test.each([
    ["not an object", [], "must be a JSON object"],
    ["no entries", {}, '"entries"'],
    ["empty entries", { entries: [] }, '"entries"'],
    ["unknown key", { entries: ["a"], gate: [] }, 'unknown key "gate"'],
    ["unknown gate", { entries: ["a"], gates: ["nope"] }, 'unknown gate "nope"'],
    ["bad threshold", { entries: ["a"], duplication: { minTokens: 0 } }, "minTokens"],
    ["null duplication", { entries: ["a"], duplication: null }, "minTokens"],
  ])("rejects %s", (_name, raw, messagePart) => {
    const result = parseTaskConfig(raw, "c");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(messagePart);
  });
});

describe("loadTaskConfig", () => {
  test.each(["te-be", "tm-be", "th-be"])("shipped config %s is valid", (taskId) => {
    expect(loadTaskConfig(taskId).ok).toBe(true);
  });

  test("names a missing task and rejects path-like ids", () => {
    const missing = loadTaskConfig("zz-nope");
    expect(missing.ok ? "" : missing.error).toContain("no config for task");
    expect(loadTaskConfig("../x").ok).toBe(false);
  });
});
