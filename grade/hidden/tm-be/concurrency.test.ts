// Spec: "Shared database" and Idempotency (High tier). Same-process concurrency: one app, and two app instances on one dbPath.
// Only outcomes are asserted: which request wins is unspecified, never how long anything takes.
import { describe, expect, test } from "bun:test";
import {
  THIRDS,
  authorized,
  captured,
  countBy,
  expectBalances,
  expectPayment,
  feesOf,
  outcomeKey,
  refunded,
  seededShuffle,
  split,
  withWorld,
  type Client,
  type EventBody,
  type Reply,
  type World,
} from "./support.ts";

const TIMEOUT_MS = 30_000;
const topologies: [string, number][] = [
  ["one app", 1],
  ["two app instances on one dbPath", 2],
];

/** Fires every event at once, spreading them round-robin over the clients. */
function fireAll(clients: Client[], events: (EventBody | string)[]): Promise<Reply[]> {
  return Promise.all(events.map((event, index) => (clients[index % clients.length] as Client).send(event)));
}
const openClients = (world: World, count: number, options = {}): Client[] => Array.from({ length: count }, () => world.open(options));

for (const [topology, instances] of topologies) {
  describe(`concurrency (${topology})`, () => {
    test("24 identical authorizations: exactly one processed, the rest duplicate", () =>
      withWorld(async (world) => {
        // Bug caught: check-then-insert race on the event id (two requests both see "new").
        const clients = openClients(world, instances);
        const replies = await fireAll(clients, Array.from({ length: 24 }, () => authorized("e1", "pay_1", 100, "USD")));
        expect(countBy(replies, outcomeKey)).toEqual({ "200 processed": 1, "200 duplicate": 23 });
        await expectPayment(clients[0] as Client, "pay_1", { status: "authorized", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
      }), TIMEOUT_MS);

    test("24 identical captures credit the ledger exactly once", () =>
      withWorld(async (world) => {
        // Bug caught: double credit when the same capture is delivered concurrently.
        const clients = openClients(world, instances, { fees: feesOf(1000, { USD: 17 }) });
        await (clients[0] as Client).send(authorized("e1", "pay_1", 131, "USD", THIRDS));
        const replies = await fireAll(clients, Array.from({ length: 24 }, () => captured("e2", "pay_1")));
        expect(countBy(replies, outcomeKey)).toEqual({ "200 processed": 1, "200 duplicate": 23 });
        await expectBalances(clients[0] as Client, "m_a", { USD: 34 });
        await expectBalances(clients[instances - 1] as Client, "m_b", { USD: 33 });
        await expectBalances(clients[0] as Client, "m_c", { USD: 34 });
      }), TIMEOUT_MS);

    test("24 identical refunds debit exactly once", () =>
      withWorld(async (world) => {
        // Bug caught: double debit when the same refund is delivered concurrently.
        const clients = openClients(world, instances);
        await (clients[0] as Client).send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)]));
        await (clients[0] as Client).send(captured("e2", "pay_1"));
        const replies = await fireAll(clients, Array.from({ length: 24 }, () => refunded("e3", "pay_1", 40)));
        expect(countBy(replies, outcomeKey)).toEqual({ "200 processed": 1, "200 duplicate": 23 });
        await expectBalances(clients[0] as Client, "m_a", { USD: 60 });
        await expectPayment(clients[0] as Client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 40 });
      }), TIMEOUT_MS);

    test("24 identical deferred events: exactly one deferred, the rest duplicate, and a later release applies it once", () =>
      withWorld(async (world) => {
        // Bug caught: the same deferred event stored several times, then applied several times on release.
        const clients = openClients(world, instances);
        const replies = await fireAll(clients, Array.from({ length: 24 }, () => refunded("e3", "pay_1", 30)));
        expect(countBy(replies, outcomeKey)).toEqual({ "202 deferred": 1, "200 duplicate": 23 });
        await (clients[0] as Client).send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)]));
        await (clients[0] as Client).send(captured("e2", "pay_1"));
        await expectBalances(clients[0] as Client, "m_a", { USD: 70 });
      }), TIMEOUT_MS);

    test("12 events with one id but different bodies: exactly one takes effect, the others are 409", () =>
      withWorld(async (world) => {
        // Bug caught: two conflicting writers both winning, or a loser's body overwriting the winner's.
        const clients = openClients(world, instances);
        const variants = Array.from({ length: 12 }, (_, index) => authorized("e1", "pay_1", 1000 + index, "USD"));
        const replies = await fireAll(clients, variants);
        expect(countBy(replies, outcomeKey)).toEqual({ "200 processed": 1, "409 event_conflict": 11 });
        const winner = replies.findIndex((reply) => reply.status === 200);
        await expectPayment(clients[0] as Client, "pay_1", { status: "authorized", amountMinor: 1000 + winner, currency: "USD", feeMinor: null, refundedMinor: 0 });
        const repeat = await (clients[instances - 1] as Client).send(variants[winner] as EventBody);
        expect(outcomeKey(repeat)).toBe("200 duplicate");
      }), TIMEOUT_MS);

    test("30 distinct refunds of 10 against a capture of 100: exactly 10 apply, 20 are 422, nothing over-refunded", () =>
      withWorld(async (world) => {
        // Bug caught: read-check-write race on the refunded total that lets refunds exceed the capture.
        const clients = openClients(world, instances);
        await (clients[0] as Client).send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)]));
        await (clients[0] as Client).send(captured("e2", "pay_1"));
        const events = Array.from({ length: 30 }, (_, index) => refunded(`r${index}`, "pay_1", 10));
        const replies = await fireAll(clients, events);
        expect(countBy(replies, outcomeKey)).toEqual({ "200 processed": 10, "422 refund_exceeds_capture": 20 });
        await expectPayment(clients[0] as Client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 100 });
        await expectBalances(clients[instances - 1] as Client, "m_a", { USD: 0 });
      }), TIMEOUT_MS);

    test("12 captures of different payments credit one merchant without losing an update", () =>
      withWorld(async (world) => {
        // Bug caught: lost update on a shared balance row (read balance, add, write back without isolation).
        const clients = openClients(world, instances);
        const ids = Array.from({ length: 12 }, (_, index) => index);
        await fireAll(clients, ids.map((index) => authorized(`a${index}`, `pay_${index}`, 100 + index, "USD", [split("m_a", 10000)])));
        const replies = await fireAll(clients, ids.map((index) => captured(`c${index}`, `pay_${index}`)));
        expect(countBy(replies, outcomeKey)).toEqual({ "200 processed": 12 });
        const expected = ids.reduce((sum, index) => sum + 100 + index, 0);
        await expectBalances(clients[0] as Client, "m_a", { USD: expected });
      }), TIMEOUT_MS);

    test("authorization, capture and refund of 8 payments arriving shuffled, each sent 3 times, end exactly as if sequential", () =>
      withWorld(async (world) => {
        // Bug caught: lost or doubled deferred release when events for one payment race each other.
        const clients = openClients(world, instances);
        const payments = Array.from({ length: 8 }, (_, index) => index);
        const events: EventBody[] = payments.flatMap((index) => [
          authorized(`a${index}`, `pay_${index}`, 1000, "USD", [split(`m_${index % 2}`, 10000)]),
          captured(`c${index}`, `pay_${index}`),
          refunded(`r${index}`, `pay_${index}`, 100 + index),
        ]);
        const triple = events.flatMap((event) => [event, event, event]);
        const replies = await fireAll(clients, seededShuffle(triple, 20240607));
        for (const reply of replies) expect([200, 202]).toContain(reply.status);
        for (const index of payments) {
          await expectPayment(clients[0] as Client, `pay_${index}`, { status: "captured", amountMinor: 1000, currency: "USD", feeMinor: 0, refundedMinor: 100 + index });
        }
        const evenRefunds = payments.filter((index) => index % 2 === 0).reduce((sum, index) => sum + 100 + index, 0);
        const oddRefunds = payments.filter((index) => index % 2 === 1).reduce((sum, index) => sum + 100 + index, 0);
        await expectBalances(clients[instances - 1] as Client, "m_0", { USD: 4000 - evenRefunds });
        await expectBalances(clients[instances - 1] as Client, "m_1", { USD: 4000 - oddRefunds });
        // Every id is recorded exactly once: all repeats are duplicates now.
        const repeats = await fireAll(clients, events);
        expect(countBy(repeats, outcomeKey)).toEqual({ "200 duplicate": events.length });
      }), TIMEOUT_MS);
  });
}
