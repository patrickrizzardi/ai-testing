// Spec: "Atomicity" and `hooks.beforeCommit` (High tier: a request's changes commit together or not at all).
import { describe, expect, test } from "bun:test";
import {
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
  refunded,
  snapshot,
  split,
  withWorld,
  type World,
} from "./support.ts";

const SOLE = [split("m_a", 10000)];

/** A hook that throws `thrown` the first time it sees `targetId` and records every call. */
function throwingOnce(targetId: string, thrown: unknown = new Error("boom-internal-detail")) {
  const calls: string[] = [];
  let armed = true;
  return {
    calls,
    hooks: {
      beforeCommit: (eventId: string) => {
        calls.push(eventId);
        if (armed && eventId === targetId) {
          armed = false;
          throw thrown;
        }
      },
    },
  };
}

function expectInternalErrorWithoutDetail(reply: Awaited<ReturnType<ReturnType<World["open"]>["send"]>>): void {
  expectError(reply, 500, "internal_error");
  expect(reply.text).not.toContain("boom-internal-detail");
  expect(reply.text).not.toMatch(/\.(ts|js):\d+|node_modules|\n\s+at /);
}

describe("atomicity: beforeCommit is called once per request that would change data, with the event id", () => {
  test("called for processed, ignored and deferred answers only; once per request even when it releases deferred events", () =>
    withWorld(async (world) => {
      // Bug caught: calling the hook per applied event, for duplicates/errors, or never.
      const calls: string[] = [];
      const client = world.open({ hooks: { beforeCommit: (eventId) => void calls.push(eventId) } });
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      expect(calls).toEqual(["e1"]);
      expectDuplicate(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      expectError(await client.send(authorized("e1", "pay_1", 101, "USD", SOLE)), 409, "event_conflict");
      expectError(await client.send("{"), 400, "invalid_input");
      expectError(await client.send(authorized("e_bad", "pay_9", 100, "usd", SOLE)), 422, "unsupported_currency");
      expectError(await client.send(authorized("e_sig", "pay_9", 100, "USD", SOLE), { secret: "other" }), 401, "invalid_signature");
      expectError(await client.get("/payments/none"), 404, "not_found");
      expectError(await client.request("DELETE", "/webhooks"), 405, "method_not_allowed");
      expect(calls).toEqual(["e1"]);

      expectProcessed(await client.send(captured("e2", "pay_1")));
      expectError(await client.send(refunded("e_over", "pay_1", 101)), 422, "refund_exceeds_capture");
      expect(calls).toEqual(["e1", "e2"]);
      expectIgnored(await client.send(failed("e3", "pay_1")));
      expectDeferred(await client.send(refunded("e4", "pay_2", 5)));
      expect(calls).toEqual(["e1", "e2", "e3", "e4"]);

      // One request that releases two deferred events calls the hook once, with the request's own id.
      expectDeferred(await client.send(captured("e5", "pay_3")));
      expectDeferred(await client.send(refunded("e6", "pay_3", 10)));
      calls.length = 0;
      expectProcessed(await client.send(authorized("e7", "pay_3", 100, "USD", SOLE)));
      expect(calls).toEqual(["e7"]);
    }));
});

describe("atomicity: a throwing beforeCommit rolls the request back and the event can be delivered again", () => {
  test("authorization: 500, no payment, id unused; redelivery is processed once", () =>
    withWorld(async (world) => {
      // Bug caught: committing before the hook runs, or recording the event id outside the transaction.
      const { hooks } = throwingOnce("e1");
      const client = world.open({ hooks });
      expectInternalErrorWithoutDetail(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      await expectNoPayment(client, "pay_1");
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      expectDuplicate(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      await expectPayment(client, "pay_1", { status: "authorized", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
    }));

  test("capture: 500, payment still authorized, no ledger entry; redelivery credits once", () =>
    withWorld(async (world) => {
      // Bug caught: ledger credit or payment state committed in a separate transaction from the event record.
      const { hooks } = throwingOnce("e2");
      const client = world.open({ hooks });
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      expectInternalErrorWithoutDetail(await client.send(captured("e2", "pay_1")));
      await expectPayment(client, "pay_1", { status: "authorized", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
      await expectNoLedger(client, "m_a");
      expectProcessed(await client.send(captured("e2", "pay_1")));
      await expectBalances(client, "m_a", { USD: 100 });
      expectDuplicate(await client.send(captured("e2", "pay_1")));
      await expectBalances(client, "m_a", { USD: 100 });
    }));

  test("refund: 500 leaves refundedMinor and balances untouched; redelivery debits once", () =>
    withWorld(async (world) => {
      // Bug caught: partial application of a refund (refundedMinor bumped, ledger not, or the reverse).
      const { hooks } = throwingOnce("e3");
      const client = world.open({ hooks });
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      const before = await snapshot(client, ["pay_1"], ["m_a"]);
      expectInternalErrorWithoutDetail(await client.send(refunded("e3", "pay_1", 40)));
      expect(await snapshot(client, ["pay_1"], ["m_a"])).toEqual(before);
      expectProcessed(await client.send(refunded("e3", "pay_1", 40)));
      await expectBalances(client, "m_a", { USD: 60 });
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 40 });
    }));

  test("ignored event: 500 records nothing; redelivery answers ignored, not duplicate", () =>
    withWorld(async (world) => {
      // Bug caught: recording the id of an ignored event before the commit.
      const { hooks } = throwingOnce("e3");
      const client = world.open({ hooks });
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      expectProcessed(await client.send(failed("e2", "pay_1")));
      expectInternalErrorWithoutDetail(await client.send(captured("e3", "pay_1")));
      expectIgnored(await client.send(captured("e3", "pay_1")));
      expectDuplicate(await client.send(captured("e3", "pay_1")));
    }));

  test("deferred event: 500 stores nothing; redelivery answers deferred and the event is not released early", () =>
    withWorld(async (world) => {
      // Bug caught: leaving the deferred event stored when the request failed, so a later authorization releases a capture nobody acknowledged.
      const { hooks } = throwingOnce("e_cap");
      const client = world.open({ hooks });
      expectInternalErrorWithoutDetail(await client.send(captured("e_cap", "pay_1")));
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      await expectPayment(client, "pay_1", { status: "authorized", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
      await expectNoLedger(client, "m_a");
      expectProcessed(await client.send(captured("e_cap", "pay_1")));
      await expectBalances(client, "m_a", { USD: 100 });
    }));

  test("a capture that releases a deferred refund: 500 undoes both; redelivery applies capture and refund exactly once", () =>
    withWorld(async (world) => {
      // Bug caught: released events committed (or removed from the deferred list) even though the triggering request rolled back.
      const { hooks } = throwingOnce("e2");
      const client = world.open({ hooks });
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      expectDeferred(await client.send(refunded("e3", "pay_1", 30)));
      const before = await snapshot(client, ["pay_1"], ["m_a"]);
      expectInternalErrorWithoutDetail(await client.send(captured("e2", "pay_1")));
      expect(await snapshot(client, ["pay_1"], ["m_a"])).toEqual(before);
      expectProcessed(await client.send(captured("e2", "pay_1")));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 30 });
      await expectBalances(client, "m_a", { USD: 70 });
      expectDuplicate(await client.send(refunded("e3", "pay_1", 30)));
      await expectBalances(client, "m_a", { USD: 70 });
    }));

  test("an authorization that releases deferred capture and refund: 500 leaves them deferred; redelivery releases them once", () =>
    withWorld(async (world) => {
      // Bug caught: the deferred list being consumed inside a transaction that is not rolled back with the rest.
      const { hooks } = throwingOnce("e1");
      const client = world.open({ hooks });
      expectDeferred(await client.send(refunded("e3", "pay_1", 30)));
      expectDeferred(await client.send(captured("e2", "pay_1")));
      expectInternalErrorWithoutDetail(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      await expectNoPayment(client, "pay_1");
      await expectNoLedger(client, "m_a");
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 30 });
      await expectBalances(client, "m_a", { USD: 70 });
    }));

  const thrownValues: [string, unknown][] = [
    ["an Error", new Error("boom-internal-detail")],
    ["a string", "boom-internal-detail"],
    ["a number", 42],
    ["null", null],
  ];
  for (const [name, thrown] of thrownValues) {
    test(`the hook throws ${name}: fetch still resolves with 500 internal_error`, () =>
      withWorld(async (world) => {
        // Bug caught: assuming the thrown value is an Error (reading .message), or letting it escape fetch.
        const { hooks } = throwingOnce("e1", thrown);
        const client = world.open({ hooks });
        expectInternalErrorWithoutDetail(await client.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
        await expectNoPayment(client, "pay_1");
      }));
  }

  test("after a rolled-back request the database is not left locked: another instance and the same instance can still write", () =>
    withWorld(async (world) => {
      // Bug caught: a transaction left open after the hook threw (other instances then wait forever or fail with SQLITE_BUSY).
      const { hooks } = throwingOnce("e1");
      const failing = world.open({ hooks });
      const other = world.open();
      expectInternalErrorWithoutDetail(await failing.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
      expectProcessed(await other.send(authorized("e2", "pay_2", 50, "USD", SOLE)));
      expectProcessed(await failing.send(authorized("e3", "pay_3", 60, "USD", SOLE)));
      expectProcessed(await other.send(authorized("e1", "pay_1", 100, "USD", SOLE)));
    }), 20_000);
});
