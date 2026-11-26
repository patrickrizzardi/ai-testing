// Spec: POST /webhooks, step 3 "Idempotency" (High tier: retried writes must take effect at most once).
import { describe, expect, test } from "bun:test";
import {
  CREATED_AT,
  THIRDS,
  authorized,
  captured,
  expectBalances,
  expectDeferred,
  expectDuplicate,
  expectError,
  expectIgnored,
  expectNoLedger,
  expectNoPayment,
  expectPayment,
  expectProcessed,
  failed,
  feesOf,
  refunded,
  split,
  withWorld,
} from "./support.ts";

const HALVES = [split("m_a", 5000), split("m_b", 5000)];

describe("idempotency: an exact repeat answers duplicate and changes nothing", () => {
  test("repeat of a processed authorization", () =>
    withWorld(async (world) => {
      // Bug caught: re-applying the event, or answering processed/ignored for a repeat.
      const client = world.open();
      const event = authorized("e1", "pay_1", 100, "USD", HALVES);
      expectProcessed(await client.send(event));
      expectDuplicate(await client.send(event));
      await expectPayment(client, "pay_1", { status: "authorized", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
    }));

  test("repeat of a processed capture credits the merchants once", () =>
    withWorld(async (world) => {
      // Bug caught: crediting the ledger on every delivery (the classic double-credit).
      const client = world.open({ fees: feesOf(1000, { USD: 17 }) });
      expectProcessed(await client.send(authorized("e1", "pay_1", 131, "USD", THIRDS)));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      expectDuplicate(await client.send(captured("e2", "pay_1")));
      expectDuplicate(await client.send(captured("e2", "pay_1")));
      await expectBalances(client, "m_a", { USD: 34 });
      await expectBalances(client, "m_b", { USD: 33 });
      await expectBalances(client, "m_c", { USD: 34 });
    }));

  test("repeat of a processed refund debits once, and a repeat of a refund that used up the capture is duplicate, not 422", () =>
    withWorld(async (world) => {
      // Bug caught: running the refund-amount check before the idempotency check (spec: "never refund_exceeds_capture").
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      expectProcessed(await client.send(refunded("e3", "pay_1", 100)));
      expectDuplicate(await client.send(refunded("e3", "pay_1", 100)));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 100 });
      await expectBalances(client, "m_a", { USD: 0 });
    }));

  test("repeat of an ignored event answers duplicate (not ignored)", () =>
    withWorld(async (world) => {
      // Bug caught: not recording ids of ignored events.
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD")));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      const lateAuthorization = authorized("e3", "pay_1", 999, "USD");
      expectIgnored(await client.send(lateAuthorization));
      expectDuplicate(await client.send(lateAuthorization));
    }));

  test("repeat of a deferred event answers 200 duplicate (not 202) and does not queue it twice", () =>
    withWorld(async (world) => {
      // Bug caught: not recording deferred ids, or queueing a deferred refund twice so it is applied twice on release.
      const client = world.open();
      const refund = refunded("e_ref", "pay_1", 30);
      expectDeferred(await client.send(refund));
      expectDuplicate(await client.send(refund));
      expectDuplicate(await client.send(refund));
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 30 });
      await expectBalances(client, "m_a", { USD: 70 });
    }));

  test("repeat of an event that was released from the deferred list is duplicate", () =>
    withWorld(async (world) => {
      // Bug caught: forgetting a deferred event's id once it has been released.
      const client = world.open();
      const early = captured("e_early", "pay_1");
      expectDeferred(await client.send(early));
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectDuplicate(await client.send(early));
      await expectBalances(client, "m_a", { USD: 100 });
    }));

  test("repeat of a deferred event that was discarded on release is duplicate", () =>
    withWorld(async (world) => {
      // Bug caught: forgetting the id of a discarded (released-as-ignored) event, which would let it be re-applied.
      const client = world.open();
      const failure = failed("e_fail", "pay_1");
      expectDeferred(await client.send(captured("e_cap", "pay_1")));
      expectDeferred(await client.send(failure));
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
      expectDuplicate(await client.send(failure));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
    }));
});

describe("idempotency: 'identical' means equal as parsed JSON; the signature is not compared", () => {
  const original = authorized("e1", "pay_1", 100, "USD", HALVES);
  const originalJson = JSON.stringify(original);
  const samePayloads: [string, string][] = [
    ["pretty-printed with different whitespace", JSON.stringify(original, null, 4)],
    ["keys in another order at every level", JSON.stringify({ data: { splits: HALVES.map((one) => ({ weightBps: one.weightBps, merchantId: one.merchantId })), currency: "USD", amountMinor: 100, paymentId: "pay_1" }, createdAt: CREATED_AT, type: "payment.authorized", id: "e1" })],
    ["a number written as 100.0", originalJson.replace('"amountMinor":100', '"amountMinor":100.0')],
    ["a number written as 1e2", originalJson.replace('"amountMinor":100', '"amountMinor":1e2')],
    ["a string with a unicode escape", originalJson.replace('"pay_1"', '"pay\\u005f1"')],
    ["a string with a unicode escape in the id", originalJson.replace('"e1"', '"\\u0065\\u0031"')],
  ];
  for (const [name, raw] of samePayloads) {
    test(`same value, ${name}: duplicate`, () =>
      withWorld(async (world) => {
        // Bug caught: comparing raw text (or a re-serialisation that depends on key order/number spelling).
        const client = world.open();
        expectProcessed(await client.send(original));
        expectDuplicate(await client.send(raw));
      }));
  }

  test("a repeat signed with another t (and therefore another v1) is duplicate", () =>
    withWorld(async (world) => {
      // Bug caught: storing and comparing the signature header or the request time with the body.
      const client = world.open();
      expectProcessed(await client.send(original));
      world.clock.ms += 120_000;
      expectDuplicate(await client.send(original));
    }));

  test("the recorded body is compared with extra fields included: an extra field repeats as conflict, both ways", () =>
    withWorld(async (world) => {
      // Bug caught: comparing only the fields the receiver understands (spec: "extra fields count").
      const client = world.open();
      expectProcessed(await client.send({ ...original, note: "first" }));
      expectDuplicate(await client.send({ ...original, note: "first" }));
      expectError(await client.send({ ...original, note: "second" }), 409, "event_conflict");
      expectError(await client.send(original), 409, "event_conflict");
      expectError(await client.send({ ...original, note: "first", more: 1 }), 409, "event_conflict");
    }));
});

describe("idempotency: same id, different body answers 409 event_conflict with no effect", () => {
  const original = authorized("e1", "pay_1", 100, "USD", HALVES);
  const different: [string, Record<string, unknown>][] = [
    ["another amount", authorized("e1", "pay_1", 101, "USD", HALVES)],
    ["another currency", authorized("e1", "pay_1", 100, "EUR", HALVES)],
    ["another payment id", authorized("e1", "pay_2", 100, "USD", HALVES)],
    ["splits in another order", authorized("e1", "pay_1", 100, "USD", [split("m_b", 5000), split("m_a", 5000)])],
    ["another split weight", authorized("e1", "pay_1", 100, "USD", [split("m_a", 5001), split("m_b", 4999)])],
    ["another createdAt", { ...original, createdAt: "2023-11-14T22:13:21Z" }],
    ["another event type", captured("e1", "pay_1")],
    ["a refund under a capture's id", refunded("e1", "pay_1", 5)],
  ];
  for (const [name, body] of different) {
    test(`recorded authorization vs ${name}`, () =>
      withWorld(async (world) => {
        // Bug caught: treating a reused id as a duplicate (silently dropping the new content) or applying it.
        const client = world.open();
        expectProcessed(await client.send(original));
        expectError(await client.send(body), 409, "event_conflict");
        await expectPayment(client, "pay_1", { status: "authorized", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
        await expectNoPayment(client, "pay_2");
        // The original is still a duplicate afterwards: the conflicting send did not replace the record.
        expectDuplicate(await client.send(original));
      }));
  }

  test("conflict against a recorded ignored event and a recorded deferred event", () =>
    withWorld(async (world) => {
      // Bug caught: only processed events are compared; ignored/deferred ids are forgotten or overwritten.
      const client = world.open();
      expectDeferred(await client.send(captured("e_def", "pay_1")));
      expectError(await client.send(captured("e_def", "pay_2")), 409, "event_conflict");
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD")));
      expectIgnored(await client.send(authorized("e_ign", "pay_1", 5, "USD")));
      expectError(await client.send(authorized("e_ign", "pay_1", 6, "USD")), 409, "event_conflict");
      // A conflict on the deferred id must not have rerouted the deferred capture to pay_2.
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
      await expectNoPayment(client, "pay_2");
    }));

  test("a conflicting capture body does not credit or change the ledger", () =>
    withWorld(async (world) => {
      // Bug caught: applying the new body of a conflicting event before comparing it.
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(authorized("e2", "pay_2", 200, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(captured("e3", "pay_1")));
      expectError(await client.send(captured("e3", "pay_2")), 409, "event_conflict");
      await expectBalances(client, "m_a", { USD: 100 });
      await expectPayment(client, "pay_2", { status: "authorized", amountMinor: 200, currency: "USD", feeMinor: null, refundedMinor: 0 });
    }));
});

describe("idempotency: the event id alone decides", () => {
  test("two refunds with the same refundId under different event ids are both applied", () =>
    withWorld(async (world) => {
      // Bug caught: de-duplicating on refundId, which the spec says has no effect.
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      expectProcessed(await client.send(refunded("e3", "pay_1", 10, "ref_same")));
      expectProcessed(await client.send(refunded("e4", "pay_1", 10, "ref_same")));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 20 });
      await expectBalances(client, "m_a", { USD: 80 });
    }));

  test("a rejected over-refund does not record its id: the same id with a smaller amount is processed, the same body fails again", () =>
    withWorld(async (world) => {
      // Bug caught: recording the event id before the refund-amount check (spec: "the event id stays unused").
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      expectError(await client.send(refunded("e3", "pay_1", 101)), 422, "refund_exceeds_capture");
      expectError(await client.send(refunded("e3", "pay_1", 101)), 422, "refund_exceeds_capture");
      expectProcessed(await client.send(refunded("e3", "pay_1", 100)));
      expectDuplicate(await client.send(refunded("e3", "pay_1", 100)));
    }));
});

describe("idempotency: state is shared through the database file", () => {
  test("a second app instance created later on the same path sees recorded events and the ledger", () =>
    withWorld(async (world) => {
      // Bug caught: an in-memory idempotency set or ledger cache instead of the database.
      const first = world.open();
      expectProcessed(await first.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await first.send(captured("e2", "pay_1")));
      first.app.close();
      const second = world.open();
      expectDuplicate(await second.send(captured("e2", "pay_1")));
      expectError(await second.send(captured("e2", "pay_2")), 409, "event_conflict");
      await expectBalances(second, "m_a", { USD: 100 });
      await expectPayment(second, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
    }));

  test("two instances open at once on one path share events and balances in both directions", () =>
    withWorld(async (world) => {
      // Bug caught: per-instance caches that go stale when another instance writes.
      const left = world.open();
      const right = world.open();
      expectProcessed(await left.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectDuplicate(await right.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await right.send(captured("e2", "pay_1")));
      expectDuplicate(await left.send(captured("e2", "pay_1")));
      await expectBalances(left, "m_a", { USD: 100 });
      await expectBalances(right, "m_a", { USD: 100 });
    }));

  test("deferred events are stored in the database: another instance releases them", () =>
    withWorld(async (world) => {
      // Bug caught: keeping the deferred list in process memory.
      const left = world.open();
      const right = world.open();
      expectDeferred(await left.send(refunded("e3", "pay_1", 30)));
      expectDeferred(await left.send(captured("e2", "pay_1")));
      expectProcessed(await right.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      await expectBalances(left, "m_a", { USD: 70 });
    }));

  test("':memory:' is private to its instance", () =>
    withWorld(async (world) => {
      // Bug caught: treating ":memory:" as a shared file name or a shared-cache URI.
      const first = world.open({ dbPath: ":memory:" });
      const second = world.open({ dbPath: ":memory:" });
      expectProcessed(await first.send(authorized("e1", "pay_1", 100, "USD")));
      await expectNoPayment(second, "pay_1");
      expectProcessed(await second.send(authorized("e1", "pay_1", 100, "USD")));
    }));

  test("createApp creates the database file and schema when absent", () =>
    withWorld(async (world) => {
      // Bug caught: requiring a pre-created file or a separate migration step.
      const { existsSync } = await import("node:fs");
      expect(existsSync(world.dbPath)).toBe(false);
      const client = world.open();
      expect(existsSync(world.dbPath)).toBe(true);
      await expectNoLedger(client, "m_a");
    }));
});
