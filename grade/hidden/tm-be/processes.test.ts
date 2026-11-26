// Spec: "Shared database" across several processes (High tier). Three `bun src/main.ts` servers share one database file.
// Only outcomes are asserted. Requests are signed with the real clock because a child process cannot be given `now`.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withServers, type ServerProcess } from "./servers.ts";
import { MAX_SAFE, ZERO_FEES, authorized, captured, countBy, feesOf, outcomeKey, refunded, seededShuffle, split, withWorld, type EventBody, type Reply } from "./support.ts";

const TIMEOUT_MS = 90_000;
const SERVER_COUNT = 3;

function fireAll(servers: ServerProcess[], events: EventBody[]): Promise<Reply[]> {
  return Promise.all(events.map((event, index) => (servers[index % servers.length] as ServerProcess).send(event)));
}

async function expectSameOnEveryServer(servers: ServerProcess[], path: string, expected: unknown): Promise<void> {
  for (const server of servers) {
    const reply = await server.get(path);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(expected);
  }
}

describe("processes: 3 server processes on one new dbPath", () => {
  test("30 identical authorizations then 30 identical captures take effect exactly once", () =>
    withWorld(async (world) => {
      // Bug caught: in-memory idempotency guard, or a guard that is not atomic across processes (double credit).
      await withServers(SERVER_COUNT, { dbPath: join(world.directory, "shared.db"), fees: feesOf(1000, { USD: 17 }) }, async (servers) => {
        const authorization = authorized("e1", "pay_1", 131, "USD", [split("m_a", 3333), split("m_b", 3333), split("m_c", 3334)]);
        const authorizations = await fireAll(servers, Array.from({ length: 30 }, () => authorization));
        expect(countBy(authorizations, outcomeKey)).toEqual({ "200 processed": 1, "200 duplicate": 29 });
        const capture = captured("e2", "pay_1");
        const captures = await fireAll(servers, Array.from({ length: 30 }, () => capture));
        expect(countBy(captures, outcomeKey)).toEqual({ "200 processed": 1, "200 duplicate": 29 });
        await expectSameOnEveryServer(servers, "/balances/m_a", { merchantId: "m_a", balances: { USD: 34 } });
        await expectSameOnEveryServer(servers, "/balances/m_b", { merchantId: "m_b", balances: { USD: 33 } });
        await expectSameOnEveryServer(servers, "/balances/m_c", { merchantId: "m_c", balances: { USD: 34 } });
        await expectSameOnEveryServer(servers, "/payments/pay_1", {
          paymentId: "pay_1",
          status: "captured",
          amountMinor: 131,
          currency: "USD",
          feeMinor: 30,
          refundedMinor: 0,
        });
      });
    }), TIMEOUT_MS);

  test("15 different bodies under one event id: exactly one wins, the others are 409, and every process agrees on the winner", () =>
    withWorld(async (world) => {
      // Bug caught: two processes both inserting the same id, or a loser overwriting the winner's stored body.
      await withServers(SERVER_COUNT, { dbPath: join(world.directory, "shared.db"), fees: ZERO_FEES }, async (servers) => {
        const variants = Array.from({ length: 15 }, (_, index) => authorized("e1", "pay_1", 1000 + index, "USD"));
        const replies = await fireAll(servers, variants);
        expect(countBy(replies, outcomeKey)).toEqual({ "200 processed": 1, "409 event_conflict": 14 });
        const winner = replies.findIndex((reply) => reply.status === 200);
        await expectSameOnEveryServer(servers, "/payments/pay_1", {
          paymentId: "pay_1",
          status: "authorized",
          amountMinor: 1000 + winner,
          currency: "USD",
          feeMinor: null,
          refundedMinor: 0,
        });
      });
    }), TIMEOUT_MS);

  test("30 distinct refunds of 10 against a capture of 100: exactly 10 apply, 20 are 422", () =>
    withWorld(async (world) => {
      // Bug caught: unsynchronised read-check-write of the refunded total across processes (over-refund).
      await withServers(SERVER_COUNT, { dbPath: join(world.directory, "shared.db"), fees: ZERO_FEES }, async (servers) => {
        await (servers[0] as ServerProcess).send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)]));
        await (servers[1] as ServerProcess).send(captured("e2", "pay_1"));
        const replies = await fireAll(servers, Array.from({ length: 30 }, (_, index) => refunded(`r${index}`, "pay_1", 10)));
        expect(countBy(replies, outcomeKey)).toEqual({ "200 processed": 10, "422 refund_exceeds_capture": 20 });
        await expectSameOnEveryServer(servers, "/balances/m_a", { merchantId: "m_a", balances: { USD: 0 } });
      });
    }), TIMEOUT_MS);

  test("6 payments x (authorization, capture, refund) shuffled and sent twice across processes end exactly as if sequential", () =>
    withWorld(async (world) => {
      // Bug caught: lost balance updates and lost or doubled deferred releases under multi-process contention.
      await withServers(SERVER_COUNT, { dbPath: join(world.directory, "shared.db"), fees: ZERO_FEES }, async (servers) => {
        const payments = Array.from({ length: 6 }, (_, index) => index);
        const events = payments.flatMap((index) => [
          authorized(`a${index}`, `pay_${index}`, 500 + index, "USD", [split("m_shared", 10000)]),
          captured(`c${index}`, `pay_${index}`),
          refunded(`r${index}`, `pay_${index}`, 100 + index),
        ]);
        const replies = await fireAll(servers, seededShuffle([...events, ...events], 777));
        for (const reply of replies) expect([200, 202]).toContain(reply.status);
        const expected = payments.reduce((sum, index) => sum + 500 + index - (100 + index), 0);
        await expectSameOnEveryServer(servers, "/balances/m_shared", { merchantId: "m_shared", balances: { USD: expected } });
        const repeats = await fireAll(servers, events);
        expect(countBy(repeats, outcomeKey)).toEqual({ "200 duplicate": events.length });
      });
    }), TIMEOUT_MS);

  test("a process started later on the same file sees what the others stored", () =>
    withWorld(async (world) => {
      // Bug caught: schema creation or state that is private to the process that started first.
      const dbPath = join(world.directory, "shared.db");
      await withServers(1, { dbPath, fees: ZERO_FEES }, async ([first]) => {
        await (first as ServerProcess).send(authorized("e1", "pay_1", MAX_SAFE, "USD", [split("m_a", 10000)]));
        await (first as ServerProcess).send(captured("e2", "pay_1"));
      });
      await withServers(1, { dbPath, fees: ZERO_FEES }, async ([second]) => {
        const reply = await (second as ServerProcess).get("/balances/m_a");
        expect(reply.body).toEqual({ merchantId: "m_a", balances: { USD: MAX_SAFE } });
        expect(outcomeKey(await (second as ServerProcess).send(captured("e2", "pay_1")))).toBe("200 duplicate");
      });
    }), TIMEOUT_MS);
});
