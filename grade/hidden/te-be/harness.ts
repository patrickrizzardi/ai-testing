import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared test harness for the te-be hidden tests (not a test file itself).

type SolutionApp = { fetch(request: Request): Promise<Response>; close(): void };
type CreateApp = (options: { dbPath: string; now?: () => Date }) => SolutionApp;

const solutionDir = process.env.SOLUTION_DIR;
if (!solutionDir) throw new Error("SOLUTION_DIR is not set");
const solutionModule = (await import(join(solutionDir, "src/app.ts"))) as { createApp: CreateApp };
export const createApp: CreateApp = solutionModule.createApp;

export type Reply = { status: number; contentType: string | null; text: string; body: unknown };

export type Env = {
  dbPath: string;
  app: SolutionApp;
  /** Sends one request; `json` is stringified, `raw` is sent as-is. */
  send(method: string, path: string, payload?: { json?: unknown; raw?: string | Uint8Array; headers?: Record<string, string> }): Promise<Reply>;
  /** Closes the app and opens a new one on the same database file. */
  reopen(now?: () => Date): void;
};

const openApps: SolutionApp[] = [];
const tempDirs: string[] = [];

export function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

/** Opens a fresh app on a fresh temp database file. */
export function newEnv(now?: () => Date): Env {
  const directory = mkdtempSync(join(tmpdir(), "te-be-hidden-"));
  tempDirs.push(directory);
  const dbPath = join(directory, "budget.db");
  const openApp = (clock?: () => Date): SolutionApp => {
    const app = createApp(clock ? { dbPath, now: clock } : { dbPath });
    openApps.push(app);
    return app;
  };
  const env: Env = {
    dbPath,
    app: openApp(now),
    async send(method, path, payload) {
      const headers = new Headers(payload?.headers);
      let body: string | ArrayBuffer | undefined;
      if (payload?.json !== undefined) {
        body = JSON.stringify(payload.json);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      } else if (payload?.raw !== undefined) {
        body = typeof payload.raw === "string" ? payload.raw : (payload.raw.buffer.slice(payload.raw.byteOffset, payload.raw.byteOffset + payload.raw.byteLength) as ArrayBuffer);
      }
      const response = await env.app.fetch(new Request(`http://localhost${path}`, { method, headers, body }));
      const text = await response.text();
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return { status: response.status, contentType: response.headers.get("content-type"), text, body: parsed };
    },
    reopen(clock) {
      closeQuietly(env.app);
      env.app = openApp(clock ?? now);
    },
  };
  return env;
}

function closeQuietly(app: SolutionApp): void {
  const index = openApps.indexOf(app);
  if (index === -1) return;
  openApps.splice(index, 1);
  app.close();
}

/** Registered with afterEach in every test file. */
export function cleanupAll(): void {
  for (const app of openApps.splice(0)) app.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export function post(env: Env, path: string, json: unknown): Promise<Reply> {
  return env.send("POST", path, { json });
}

export function postRaw(env: Env, path: string, raw: string | Uint8Array): Promise<Reply> {
  return env.send("POST", path, { raw });
}

export function summary(env: Env, userId: number | string, category: string): Promise<Reply> {
  return env.send("GET", `/users/${userId}/budgets/${category}/summary`);
}

export function expectErrorReply(reply: Reply, status: number, code: string): void {
  expect(reply.status).toBe(status);
  expect(reply.body).toBeObject();
  expect(Object.keys(reply.body as object).sort()).toEqual(["code", "message"]);
  const { code: actualCode, message } = reply.body as { code: unknown; message: unknown };
  expect(actualCode).toBe(code);
  expect(typeof message).toBe("string");
  expect((message as string).length).toBeGreaterThan(0);
  expect(reply.contentType?.split(";")[0]?.trim().toLowerCase()).toBe("application/json");
}

/** Creates a user and returns its id; asserts the 201. */
export async function createUser(env: Env, timeZone = "UTC", name = "Ada"): Promise<number> {
  const reply = await post(env, "/users", { name, timeZone });
  expect(reply.status).toBe(201);
  return (reply.body as { id: number }).id;
}

export async function createBudget(env: Env, userId: number, category: string, limitCents: number): Promise<void> {
  const reply = await post(env, `/users/${userId}/budgets`, { category, limitCents });
  expect(reply.status).toBe(201);
}

export async function createSpend(env: Env, userId: number, category: string, amountCents: number, spentAt: string): Promise<Reply> {
  const reply = await post(env, `/users/${userId}/spends`, { category, amountCents, spentAt });
  expect(reply.status).toBe(201);
  return reply;
}

/** A user with one budget, ready for spends. */
export async function userWithBudget(env: Env, options: { timeZone?: string; category?: string; limitCents?: number } = {}): Promise<number> {
  const userId = await createUser(env, options.timeZone ?? "UTC");
  await createBudget(env, userId, options.category ?? "groceries", options.limitCents ?? 50000);
  return userId;
}

/**
 * Runs one case per entry and returns the cases whose outcome differed, so one
 * test reports every wrong entry of a table instead of stopping at the first.
 */
export async function collectMismatches<Case>(
  cases: readonly Case[],
  check: (testCase: Case) => Promise<string | undefined>,
): Promise<string[]> {
  const mismatches: string[] = [];
  for (const testCase of cases) {
    const problem = await check(testCase);
    if (problem !== undefined) mismatches.push(`${JSON.stringify(testCase)}: ${problem}`);
  }
  return mismatches;
}

export type SummaryBody = {
  category: string;
  month: string;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  daysLeft: number;
  dailyAllowanceCents: number;
};

export type BodyCase = { label: string; raw?: string; json?: unknown };

/**
 * POSTs every case to `path` and returns those whose outcome is not the
 * expectation: 201, or 400 invalid_input with the exact error shape.
 */
export async function bodyMismatches(env: Env, path: string, cases: readonly BodyCase[], expected: "accepted" | "rejected"): Promise<string[]> {
  return collectMismatches(cases, async (testCase) => {
    const payload = testCase.raw !== undefined ? { raw: testCase.raw } : { json: testCase.json };
    const reply = await env.send("POST", path, payload);
    if (expected === "accepted") return reply.status === 201 ? undefined : `expected 201, got ${reply.status} ${reply.text}`;
    try {
      expectErrorReply(reply, 400, "invalid_input");
      return undefined;
    } catch {
      return `expected 400 invalid_input, got ${reply.status} ${reply.text}`;
    }
  });
}

/** Returns a copy of `base` with `field` replaced, or removed when `value` is `undefined`. */
export function withField(base: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const copy = { ...base };
  if (value === undefined) delete copy[field];
  else copy[field] = value;
  return copy;
}

/** A raw JSON text for `base` with `field` set to the literal JSON text `literal`. */
export function rawWithLiteral(base: Record<string, unknown>, field: string, literal: string): string {
  const parts = Object.entries(withField(base, field, null)).map(([key, value]) =>
    `${JSON.stringify(key)}:${key === field ? literal : JSON.stringify(value)}`,
  );
  return `{${parts.join(",")}}`;
}

/** Integer-field cases shared by limitCents and amountCents: raw JSON literals. */
export const ACCEPTED_INTEGER_LITERALS: ReadonlyArray<{ literal: string; value: number }> = [
  { literal: "1", value: 1 },
  { literal: "2", value: 2 },
  { literal: "50000", value: 50000 },
  { literal: "999999999", value: 999999999 },
  { literal: "1000000000", value: 1000000000 },
  { literal: "5.0", value: 5 },
  { literal: "5e0", value: 5 },
  { literal: "1e9", value: 1000000000 },
  { literal: "1.0E9", value: 1000000000 },
  { literal: "100E-2", value: 1 },
  { literal: "12.50e2", value: 1250 },
];

export const REJECTED_INTEGER_LITERALS: readonly string[] = [
  "0",
  "-0",
  "0.0",
  "-1",
  "-1000",
  "1000000001",
  "1000000001.0",
  "1e10",
  "1e30",
  "2147483648000",
  "9007199254740993",
  "1.5",
  "0.5",
  "1e-1",
  "1000000000.5",
  "999999999.9999999",
  '"5"',
  '"5.0"',
  '""',
  "null",
  "true",
  "false",
  "[]",
  "[5]",
  "{}",
];

export type SummaryScenario = {
  timeZone: string;
  now: string;
  limitCents: number;
  spends?: ReadonlyArray<readonly [amountCents: number, spentAt: string]>;
  category?: string;
};

/** Builds a user, a budget and spends on a fresh database, then reads the summary at `now`. */
export async function runSummaryScenario(scenario: SummaryScenario): Promise<{ reply: Reply; summary: SummaryBody }> {
  const category = scenario.category ?? "groceries";
  const env = newEnv(fixedClock(scenario.now));
  const userId = await userWithBudget(env, { timeZone: scenario.timeZone, category, limitCents: scenario.limitCents });
  for (const [amountCents, spentAt] of scenario.spends ?? []) await createSpend(env, userId, category, amountCents, spentAt);
  const reply = await summary(env, userId, category);
  expect(reply.status).toBe(200);
  return { reply, summary: reply.body as SummaryBody };
}
