// Shared helpers for the TM-BE hidden tests. Not a test file: the grader only runs *.test.ts.
import { expect } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Currency = "USD" | "EUR" | "JPY" | "BHD";
export type FeeConfig = { percentBps: number; fixedMinor: Record<Currency, number> };
export type AppOptions = {
  dbPath: string;
  secret: string;
  fees: FeeConfig;
  now?: () => Date;
  hooks?: { beforeCommit?: (eventId: string) => void };
};
export type App = { fetch(request: Request): Promise<Response>; close(): void };
export type EventBody = Record<string, unknown>;
export type SplitInput = { merchantId: string; weightBps: number };

const solutionDirectory = process.env.SOLUTION_DIR;
if (!solutionDirectory) throw new Error("SOLUTION_DIR is not set");
export const SOLUTION_DIR: string = solutionDirectory;
const appModule = await import(join(SOLUTION_DIR, "src/app.ts"));
export const createApp = appModule.createApp as (options: AppOptions) => App;
export const MAIN_PATH = join(SOLUTION_DIR, "src/main.ts");

export const SECRET = "whsec_hidden_tests";
export const SIGNED_AT_SECONDS = 1_700_000_000;
export const CREATED_AT = "2023-11-14T22:13:20Z";
export const ZERO_FEES: FeeConfig = { percentBps: 0, fixedMinor: { USD: 0, EUR: 0, JPY: 0, BHD: 0 } };
export const MAX_SAFE = 9007199254740991;

export function feesOf(percentBps: number, fixedMinor: Partial<Record<Currency, number>> = {}): FeeConfig {
  return { percentBps, fixedMinor: { USD: 0, EUR: 0, JPY: 0, BHD: 0, ...fixedMinor } };
}

// ---------- signing and requests ----------

export function signatureOf(signedAt: string, rawBody: string, secret: string = SECRET): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${signedAt}.${rawBody}`, "utf8").digest("hex");
}

export type SendOptions = {
  /** Digits written in the header and signed. Default: the harness clock's seconds. */
  signedAt?: string;
  secret?: string;
  /** Replaces the whole Webhook-Signature header value. null omits the header. */
  header?: string | null;
  method?: string;
  path?: string;
};

export function webhookRequest(baseUrl: string, rawBody: string, options: SendOptions, defaultSignedAt: string): Request {
  const signedAt = options.signedAt ?? defaultSignedAt;
  const headers = new Headers({ "content-type": "application/json" });
  const header = options.header === undefined ? `t=${signedAt},v1=${signatureOf(signedAt, rawBody, options.secret)}` : options.header;
  if (header !== null) headers.set("Webhook-Signature", header);
  const method = options.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`${baseUrl}${options.path ?? "/webhooks"}`, { method, headers, body: hasBody ? rawBody : undefined });
}

export type Reply = { status: number; contentType: string; text: string; body: unknown };

export async function toReply(response: Response): Promise<Reply> {
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text, body };
}

export function expectJsonContentType(reply: Reply): void {
  expect(reply.contentType.toLowerCase()).toContain("application/json");
}

export function expectOutcome(reply: Reply, status: number, outcome: "processed" | "ignored" | "duplicate" | "deferred"): void {
  expect(reply.status).toBe(status);
  expect(reply.body).toEqual({ status: outcome });
  expectJsonContentType(reply);
}

export const expectProcessed = (reply: Reply) => expectOutcome(reply, 200, "processed");
export const expectIgnored = (reply: Reply) => expectOutcome(reply, 200, "ignored");
export const expectDuplicate = (reply: Reply) => expectOutcome(reply, 200, "duplicate");
export const expectDeferred = (reply: Reply) => expectOutcome(reply, 202, "deferred");

export function expectError(reply: Reply, status: number, code: string): void {
  expect(reply.status).toBe(status);
  expectJsonContentType(reply);
  const body = reply.body as Record<string, unknown> | undefined;
  expect(body).toBeDefined();
  expect(Object.keys(body ?? {}).sort()).toEqual(["code", "message"]);
  expect(body?.code).toBe(code);
  expect(typeof body?.message).toBe("string");
  expect((body?.message as string).length).toBeGreaterThan(0);
}

// ---------- event builders ----------

export const split = (merchantId: string, weightBps: number): SplitInput => ({ merchantId, weightBps });
export const SOLE_MERCHANT = (merchantId = "m_a"): SplitInput[] => [split(merchantId, 10000)];
export const THIRDS: SplitInput[] = [split("m_a", 3333), split("m_b", 3333), split("m_c", 3334)];

export function authorized(id: string, paymentId: string, amountMinor: number, currency: string, splits: SplitInput[] = SOLE_MERCHANT()): EventBody {
  return { id, type: "payment.authorized", createdAt: CREATED_AT, data: { paymentId, amountMinor, currency, splits } };
}
export function captured(id: string, paymentId: string): EventBody {
  return { id, type: "payment.captured", createdAt: CREATED_AT, data: { paymentId } };
}
export function failed(id: string, paymentId: string): EventBody {
  return { id, type: "payment.failed", createdAt: CREATED_AT, data: { paymentId } };
}
export function refunded(id: string, paymentId: string, amountMinor: number, refundId = `r_${id}`): EventBody {
  return { id, type: "payment.refunded", createdAt: CREATED_AT, data: { paymentId, refundId, amountMinor } };
}

// ---------- world: one fresh database per test ----------

export type Client = {
  app: App;
  send(event: EventBody | string, options?: SendOptions): Promise<Reply>;
  get(path: string): Promise<Reply>;
  request(method: string, path: string): Promise<Reply>;
  payment(paymentId: string): Promise<Reply>;
  balance(merchantId: string): Promise<Reply>;
};

export type World = {
  dbPath: string;
  directory: string;
  clock: { ms: number };
  open(overrides?: Partial<AppOptions>): Client;
  cleanup(): void;
};

export function newWorld(): World {
  const directory = mkdtempSync(join(tmpdir(), "tm-be-hidden-"));
  const clock = { ms: SIGNED_AT_SECONDS * 1000 };
  const apps: App[] = [];
  const dbPath = join(directory, "ledger.db");

  function open(overrides: Partial<AppOptions> = {}): Client {
    const app = createApp({ dbPath, secret: SECRET, fees: ZERO_FEES, now: () => new Date(clock.ms), ...overrides });
    apps.push(app);
    const request = async (method: string, path: string) => toReply(await app.fetch(new Request(`http://localhost${path}`, { method })));
    return {
      app,
      send: async (event, options = {}) => {
        const raw = typeof event === "string" ? event : JSON.stringify(event);
        return toReply(await app.fetch(webhookRequest("http://localhost", raw, options, String(Math.floor(clock.ms / 1000)))));
      },
      get: (path) => request("GET", path),
      request,
      payment: (paymentId) => request("GET", `/payments/${encodeURIComponent(paymentId)}`),
      balance: (merchantId) => request("GET", `/balances/${encodeURIComponent(merchantId)}`),
    };
  }

  return {
    dbPath,
    directory,
    clock,
    open,
    cleanup() {
      for (const app of apps) app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Runs one test body on a fresh database and always cleans it up. */
export async function withWorld(run: (world: World) => Promise<void>): Promise<void> {
  const world = newWorld();
  try {
    await run(world);
  } finally {
    world.cleanup();
  }
}

// ---------- state snapshots ----------

export type Snapshot = Record<string, { status: number; body: unknown }>;

/** Reads payments and balances through the HTTP boundary; used to compare "before" and "after" states. */
export async function snapshot(client: Client, paymentIds: string[], merchantIds: string[]): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const paymentId of paymentIds) {
    const reply = await client.payment(paymentId);
    result[`payment:${paymentId}`] = { status: reply.status, body: reply.body };
  }
  for (const merchantId of merchantIds) {
    const reply = await client.balance(merchantId);
    result[`balance:${merchantId}`] = { status: reply.status, body: reply.body };
  }
  return result;
}

export async function expectPayment(
  client: Client,
  paymentId: string,
  expected: { status: "authorized" | "captured" | "failed"; amountMinor: number; currency: string; feeMinor: number | null; refundedMinor: number },
): Promise<void> {
  const reply = await client.payment(paymentId);
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual({ paymentId, ...expected });
}

export async function expectBalances(client: Client, merchantId: string, balances: Partial<Record<Currency, number>>): Promise<void> {
  const reply = await client.balance(merchantId);
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual({ merchantId, balances });
}

export async function expectNoLedger(client: Client, merchantId: string): Promise<void> {
  expectError(await client.balance(merchantId), 404, "not_found");
}

export async function expectNoPayment(client: Client, paymentId: string): Promise<void> {
  expectError(await client.payment(paymentId), 404, "not_found");
}

// ---------- deterministic shuffling ----------

export function seededShuffle<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(next() * (index + 1));
    [copy[index], copy[swapWith]] = [copy[swapWith] as T, copy[index] as T];
  }
  return copy;
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

export function outcomeKey(reply: Reply): string {
  const body = reply.body as Record<string, unknown> | undefined;
  return `${reply.status} ${String(body?.status ?? body?.code)}`;
}
