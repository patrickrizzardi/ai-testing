// Spec: `src/main.ts` (`startServer(env)`, environment variables, entry-point behaviour). Medium tier.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnMain } from "./servers.ts";
import { MAIN_PATH, SECRET, ZERO_FEES, authorized, captured, createApp, feesOf, toReply, webhookRequest, withWorld } from "./support.ts";

type Running = { port: number; stop(): void };
const mainModule = await import(MAIN_PATH);
const startServer = mainModule.startServer as (env: Record<string, string | undefined>) => Running;

const FEES_JSON = JSON.stringify(feesOf(290, { USD: 30, EUR: 25, JPY: 0, BHD: 300 }));
const validEnv = (dbPath: string): Record<string, string> => ({ PORT: "0", DB_PATH: dbPath, WEBHOOK_SECRET: SECRET, FEES_JSON });

describe("startServer: serves the app with the configuration from env", () => {
  test("listens on the port it returns, applies secret, fees and DB_PATH, and stop() releases port and database", () =>
    withWorld(async (world) => {
      // Bug caught: ignoring PORT 0 (returning 0 instead of the real port), not wiring secret/fees/DB_PATH, stop() leaving the server or the db open.
      const server = startServer(validEnv(world.dbPath));
      let stopped = false;
      try {
        expect(Number.isInteger(server.port)).toBe(true);
        expect(server.port).toBeGreaterThan(0);
        const base = `http://127.0.0.1:${server.port}`;
        const now = String(Math.floor(Date.now() / 1000));
        const send = async (event: object, secret?: string) =>
          toReply(await fetch(webhookRequest(base, JSON.stringify(event), { secret }, now)));

        expect((await send(authorized("e1", "pay_1", 10000, "USD", [{ merchantId: "m_a", weightBps: 10000 }]), "wrong")).status).toBe(401);
        expect((await send(authorized("e1", "pay_1", 10000, "USD", [{ merchantId: "m_a", weightBps: 10000 }]))).body).toEqual({ status: "processed" });
        expect((await send(captured("e2", "pay_1"))).body).toEqual({ status: "processed" });
        const balance = await toReply(await fetch(`${base}/balances/m_a`));
        expect(balance.status).toBe(200);
        expect(balance.body).toEqual({ merchantId: "m_a", balances: { USD: 9680 } });
        expect(balance.contentType).toContain("application/json");

        server.stop();
        stopped = true;
        await expect(fetch(`${base}/balances/m_a`)).rejects.toBeDefined();
        // The database was closed and persisted: a fresh app on the same file sees the ledger.
        const reopened = createApp({ dbPath: world.dbPath, secret: SECRET, fees: ZERO_FEES });
        try {
          const reply = await toReply(await reopened.fetch(new Request("http://localhost/balances/m_a")));
          expect(reply.body).toEqual({ merchantId: "m_a", balances: { USD: 9680 } });
        } finally {
          reopened.close();
        }
      } finally {
        if (!stopped) server.stop();
      }
    }), 20_000);

  test("fee configs at the bounds (0 and 10000 bps) are accepted", () =>
    withWorld(async (world) => {
      // Bug caught: off-by-one in the FEES_JSON range check at startup.
      for (const percentBps of [0, 10000]) {
        const server = startServer({ ...validEnv(world.dbPath), FEES_JSON: JSON.stringify(feesOf(percentBps)) });
        server.stop();
      }
    }));
});

describe("startServer: invalid configuration throws an Error naming the variable", () => {
  const fixed = { USD: 30, EUR: 25, JPY: 0, BHD: 300 };
  const cases: [string, string, Record<string, string | undefined>][] = [
    ["WEBHOOK_SECRET missing", "WEBHOOK_SECRET", { WEBHOOK_SECRET: undefined }],
    ["FEES_JSON missing", "FEES_JSON", { FEES_JSON: undefined }],
    ["FEES_JSON not JSON", "FEES_JSON", { FEES_JSON: "{not json" }],
    ["FEES_JSON an array", "FEES_JSON", { FEES_JSON: "[]" }],
    ["FEES_JSON null", "FEES_JSON", { FEES_JSON: "null" }],
    ["FEES_JSON an empty object", "FEES_JSON", { FEES_JSON: "{}" }],
    ["FEES_JSON without fixedMinor", "FEES_JSON", { FEES_JSON: '{"percentBps":290}' }],
    ["FEES_JSON lacking a currency", "FEES_JSON", { FEES_JSON: JSON.stringify({ percentBps: 290, fixedMinor: { USD: 1, EUR: 1, JPY: 1 } }) }],
    ["FEES_JSON percentBps 10001", "FEES_JSON", { FEES_JSON: JSON.stringify({ percentBps: 10001, fixedMinor: fixed }) }],
    ["FEES_JSON percentBps negative", "FEES_JSON", { FEES_JSON: JSON.stringify({ percentBps: -1, fixedMinor: fixed }) }],
    ["FEES_JSON percentBps fractional", "FEES_JSON", { FEES_JSON: JSON.stringify({ percentBps: 1.5, fixedMinor: fixed }) }],
    ["FEES_JSON percentBps a string", "FEES_JSON", { FEES_JSON: JSON.stringify({ percentBps: "290", fixedMinor: fixed }) }],
    ["FEES_JSON fixedMinor negative", "FEES_JSON", { FEES_JSON: JSON.stringify({ percentBps: 290, fixedMinor: { ...fixed, USD: -1 } }) }],
    ["FEES_JSON fixedMinor fractional", "FEES_JSON", { FEES_JSON: JSON.stringify({ percentBps: 290, fixedMinor: { ...fixed, EUR: 0.5 } }) }],
    ["PORT not a number", "PORT", { PORT: "abc" }],
    ["PORT negative", "PORT", { PORT: "-1" }],
    ["PORT above 65535", "PORT", { PORT: "65536" }],
    ["PORT fractional", "PORT", { PORT: "80.5" }],
    ["PORT in exponent notation", "PORT", { PORT: "1e3" }],
    ["PORT with trailing text", "PORT", { PORT: "3000x" }],
  ];
  for (const [name, variable, override] of cases) {
    test(name, () =>
      withWorld(async (world) => {
        // Bug caught: starting with a bad config (or silently defaulting), or an error that does not say which variable is wrong.
        const env: Record<string, string | undefined> = { ...validEnv(world.dbPath), ...override };
        let thrown: unknown;
        let server: Running | undefined;
        try {
          server = startServer(env);
        } catch (error) {
          thrown = error;
        }
        server?.stop();
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(variable);
      }));
  }
});

describe("src/main.ts as the entry point", () => {
  const run = async (env: Record<string, string>) => {
    const child = spawnMain(env);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const exitCode = await child.exited;
    clearTimeout(timer);
    const stderr = await new Response(child.stderr as ReadableStream).text();
    return { exitCode, stderr, killed: child.signalCode === "SIGKILL" };
  };

  for (const [name, variable, override] of [
    ["WEBHOOK_SECRET missing", "WEBHOOK_SECRET", { WEBHOOK_SECRET: undefined }],
    ["FEES_JSON invalid", "FEES_JSON", { FEES_JSON: "{nope" }],
    ["PORT invalid", "PORT", { PORT: "99999" }],
  ] as const) {
    test(`running it with ${name} prints the message to stderr and exits non-zero`, () =>
      withWorld(async (world) => {
        // Bug caught: no entry-point code (exit 0), swallowing the error, an uncaught throw with a stack trace but no variable name, or a hang.
        const merged: Record<string, string | undefined> = { ...validEnv(join(world.directory, "entry.db")), ...override };
        const env = Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
        const { exitCode, stderr, killed } = await run(env);
        expect(killed).toBe(false);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain(variable);
      }), 30_000);
  }
});
