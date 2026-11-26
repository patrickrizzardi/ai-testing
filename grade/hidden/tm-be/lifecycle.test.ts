// Spec: "Applying an event": payment lifecycle table, deferred events and release (High tier: state machine).
import { describe, expect, test } from "bun:test";
import {
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
  snapshot,
  split,
  withWorld,
  type Client,
  type EventBody,
  type Reply,
} from "./support.ts";

const HALVES = [split("m_a", 5000), split("m_b", 5000)];
const authorization = (id = "e_auth") => authorized(id, "pay_1", 100, "USD", HALVES);

type StateName = "none" | "authorized" | "captured" | "failed";
const setups: Record<StateName, (client: Client) => Promise<void>> = {
  none: async () => {},
  authorized: async (client) => expectProcessed(await client.send(authorization())),
  captured: async (client) => {
    expectProcessed(await client.send(authorization()));
    expectProcessed(await client.send(captured("e_cap0", "pay_1")));
  },
  failed: async (client) => {
    expectProcessed(await client.send(authorization()));
    expectProcessed(await client.send(failed("e_fail0", "pay_1")));
  },
};

type Outcome = "processed" | "ignored" | "deferred";
type After = {
  payment: null | { status: "authorized" | "captured" | "failed"; feeMinor: number | null; refundedMinor: number };
  balance: number | null;
};
const NOTHING: After = { payment: null, balance: null };
const AUTHORIZED: After = { payment: { status: "authorized", feeMinor: null, refundedMinor: 0 }, balance: null };
const CAPTURED: After = { payment: { status: "captured", feeMinor: 0, refundedMinor: 0 }, balance: 50 };
const FAILED: After = { payment: { status: "failed", feeMinor: null, refundedMinor: 0 }, balance: null };
const REFUNDED: After = { payment: { status: "captured", feeMinor: 0, refundedMinor: 30 }, balance: 35 };

// The late authorization differs from the first one in amount, currency and merchants, so an unwanted re-creation is visible.
const lateAuthorization = () => authorized("e_event", "pay_1", 777, "EUR", [split("m_x", 10000)]);
const eventFor: Record<string, () => EventBody> = {
  authorized: lateAuthorization,
  captured: () => captured("e_event", "pay_1"),
  failed: () => failed("e_event", "pay_1"),
  refunded: () => refunded("e_event", "pay_1", 30),
};

// The spec's table, one row per cell: [event, state, outcome, resulting state].
const table: [string, StateName, Outcome, After][] = [
  ["authorized", "none", "processed", AUTHORIZED],
  ["authorized", "authorized", "ignored", AUTHORIZED],
  ["authorized", "captured", "ignored", CAPTURED],
  ["authorized", "failed", "ignored", FAILED],
  ["captured", "none", "deferred", NOTHING],
  ["captured", "authorized", "processed", CAPTURED],
  ["captured", "captured", "ignored", CAPTURED],
  ["captured", "failed", "ignored", FAILED],
  ["failed", "none", "deferred", NOTHING],
  ["failed", "authorized", "processed", FAILED],
  ["failed", "captured", "ignored", CAPTURED],
  ["failed", "failed", "ignored", FAILED],
  ["refunded", "none", "deferred", NOTHING],
  ["refunded", "authorized", "deferred", AUTHORIZED],
  ["refunded", "captured", "processed", REFUNDED],
  ["refunded", "failed", "ignored", FAILED],
];

function expectOutcomeOf(reply: Reply, outcome: Outcome): void {
  if (outcome === "processed") expectProcessed(reply);
  else if (outcome === "ignored") expectIgnored(reply);
  else expectDeferred(reply);
}

describe("lifecycle: the spec's event x state table", () => {
  for (const [eventName, state, outcome, after] of table) {
    test(`payment.${eventName} on ${state} → ${outcome}`, () =>
      withWorld(async (world) => {
        // Bug caught: a wrong cell of the table (regression out of a final state, double credit, re-creation, wrong deferral).
        const client = world.open();
        await (setups[state] as (client: Client) => Promise<void>)(client);
        const event = eventName === "authorized" && state === "none" ? authorization("e_event") : (eventFor[eventName] as () => EventBody)();
        expectOutcomeOf(await client.send(event), outcome);
        if (after.payment === null) await expectNoPayment(client, "pay_1");
        else await expectPayment(client, "pay_1", { amountMinor: 100, currency: "USD", ...after.payment });
        if (after.balance === null) {
          await expectNoLedger(client, "m_a");
          await expectNoLedger(client, "m_b");
        } else {
          await expectBalances(client, "m_a", { USD: after.balance });
          await expectBalances(client, "m_b", { USD: after.balance });
        }
        // An ignored late authorization must not have created a ledger entry for its own merchants either.
        await expectNoLedger(client, "m_x");
      }));
  }

  test("refund on authorized and on none is deferred whatever its amount: the amount check happens only when applied", () =>
    withWorld(async (world) => {
      // Bug caught: rejecting an over-large refund with 422 at deferral time.
      const client = world.open();
      expectDeferred(await client.send(refunded("e_big1", "pay_1", 9_000_000)));
      expectProcessed(await client.send(authorized("e_a", "pay_2", 100, "USD")));
      expectDeferred(await client.send(refunded("e_big2", "pay_2", 9_000_000)));
    }));
});

describe("lifecycle: deferred events are released in the same request", () => {
  test("the spec's example: refund, capture, authorization arrive reversed; the authorization answers processed and the rest follow", () =>
    withWorld(async (world) => {
      // Bug caught: deferred events never released, released in a single pass (refund stays deferred), or answered with the wrong response.
      const client = world.open();
      expectDeferred(await client.send(refunded("e3", "pay_1", 30)));
      expectDeferred(await client.send(captured("e2", "pay_1")));
      await expectNoPayment(client, "pay_1");
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 30 });
      await expectBalances(client, "m_a", { USD: 70 });
    }));

  const events = (): Record<string, EventBody> => ({
    authorization: authorized("e1", "pay_1", 131, "USD", THIRDS),
    capture: captured("e2", "pay_1"),
    refund: refunded("e3", "pay_1", 50),
  });
  const orders = [
    ["authorization", "capture", "refund"],
    ["authorization", "refund", "capture"],
    ["capture", "authorization", "refund"],
    ["capture", "refund", "authorization"],
    ["refund", "authorization", "capture"],
    ["refund", "capture", "authorization"],
  ];
  for (const order of orders) {
    test(`arrival order ${order.join(" → ")} ends with the spec's worked-example state`, () =>
      withWorld(async (world) => {
        // Bug caught: results that depend on arrival order (the whole point of deferral).
        const client = world.open({ fees: feesOf(1000, { USD: 17 }) });
        const byName = events();
        const replies: Reply[] = [];
        for (const name of order) replies.push(await client.send(byName[name] as EventBody));
        for (const reply of replies) expect([200, 202]).toContain(reply.status);
        await expectPayment(client, "pay_1", { status: "captured", amountMinor: 131, currency: "USD", feeMinor: 30, refundedMinor: 50 });
        await expectBalances(client, "m_a", { USD: 17 });
        await expectBalances(client, "m_b", { USD: 17 });
        await expectBalances(client, "m_c", { USD: 17 });
      }));
  }

  test("a state change of an existing payment (not only its creation) releases deferred events, and the answer is the trigger's own", () =>
    withWorld(async (world) => {
      // Bug caught: releasing deferred events only after payment.authorized.
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectDeferred(await client.send(refunded("e_r1", "pay_1", 30)));
      expectDeferred(await client.send(refunded("e_r2", "pay_1", 20)));
      await expectNoLedger(client, "m_a");
      expectProcessed(await client.send(captured("e2", "pay_1")));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 50 });
      await expectBalances(client, "m_a", { USD: 50 });
    }));

  test("deferred events are released in the order they were received: [failed, captured] ends failed", () =>
    withWorld(async (world) => {
      // Bug caught: releasing by event type priority or id order instead of receipt order.
      const client = world.open();
      expectDeferred(await client.send(failed("z_fail", "pay_1")));
      expectDeferred(await client.send(captured("a_cap", "pay_1")));
      expectProcessed(await client.send(authorization()));
      await expectPayment(client, "pay_1", { status: "failed", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
      await expectNoLedger(client, "m_a");
      expectDuplicate(await client.send(captured("a_cap", "pay_1")));
    }));

  test("deferred events are released in the order they were received: [captured, failed] ends captured", () =>
    withWorld(async (world) => {
      // Bug caught: as above, in the other direction (a fixed priority would satisfy only one of the two tests).
      const client = world.open();
      expectDeferred(await client.send(captured("z_cap", "pay_1")));
      expectDeferred(await client.send(failed("a_fail", "pay_1")));
      expectProcessed(await client.send(authorization()));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
      await expectBalances(client, "m_a", { USD: 50 });
    }));

  test("a deferred refund and a deferred failure on an authorized payment: the failure wins when it came last, the refund is discarded", () =>
    withWorld(async (world) => {
      // Bug caught: applying a released refund to a failed payment, or leaving it deferred forever.
      const client = world.open();
      expectProcessed(await client.send(authorization()));
      expectDeferred(await client.send(refunded("e_r", "pay_1", 10)));
      expectProcessed(await client.send(failed("e_f", "pay_1")));
      await expectPayment(client, "pay_1", { status: "failed", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
      await expectNoLedger(client, "m_a");
    }));

  test("deferred refunds are applied in receipt order and a refund that no longer fits is silently discarded: [60, 50] → 60", () =>
    withWorld(async (world) => {
      // Bug caught: applying released refunds in the wrong order, or failing/looping/leaving the loser deferred.
      const client = world.open();
      expectDeferred(await client.send(refunded("e_r60", "pay_1", 60)));
      expectDeferred(await client.send(refunded("e_r50", "pay_1", 50)));
      expectDeferred(await client.send(captured("e_cap", "pay_1")));
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 60 });
      await expectBalances(client, "m_a", { USD: 40 });
      // The discarded refund is recorded: its id answers duplicate, and a different body under it conflicts.
      expectDuplicate(await client.send(refunded("e_r50", "pay_1", 50)));
      expectError(await client.send(refunded("e_r50", "pay_1", 40)), 409, "event_conflict");
      await expectBalances(client, "m_a", { USD: 40 });
    }));

  test("deferred refunds are applied in receipt order: [50, 60] → 50", () =>
    withWorld(async (world) => {
      // Bug caught: as above with the arrival order swapped (an amount-sorted release would satisfy only one).
      const client = world.open();
      expectDeferred(await client.send(refunded("e_r50", "pay_1", 50)));
      expectDeferred(await client.send(refunded("e_r60", "pay_1", 60)));
      expectDeferred(await client.send(captured("e_cap", "pay_1")));
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 50 });
      await expectBalances(client, "m_a", { USD: 50 });
    }));

  test("a released refund larger than the whole capture is discarded; later refunds still work up to the capture", () =>
    withWorld(async (world) => {
      // Bug caught: answering or storing 422 for a released refund, or poisoning the payment.
      const client = world.open();
      expectDeferred(await client.send(refunded("e_big", "pay_1", 150)));
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
      expectProcessed(await client.send(refunded("e_ok", "pay_1", 100)));
      await expectBalances(client, "m_a", { USD: 0 });
    }));

  test("a payment that only has deferred events stays invisible, then appears captured once authorized", () =>
    withWorld(async (world) => {
      // Bug caught: creating the payment (or its ledger) at deferral time.
      const client = world.open();
      expectDeferred(await client.send(captured("e2", "pay_1")));
      await expectNoPayment(client, "pay_1");
      await expectNoLedger(client, "m_a");
      expectProcessed(await client.send(authorization()));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
    }));
});

describe("lifecycle: final states never regress", () => {
  test("captured then failed (new id) stays captured; failed then captured stays failed with no ledger entry", () =>
    withWorld(async (world) => {
      // Bug caught: letting a late or out-of-order event move a payment out of a final state.
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_c", 100, "USD", [split("m_c", 10000)])));
      expectProcessed(await client.send(captured("e2", "pay_c")));
      expectIgnored(await client.send(failed("e3", "pay_c")));
      await expectPayment(client, "pay_c", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
      expectProcessed(await client.send(authorized("e4", "pay_f", 100, "USD", [split("m_f", 10000)])));
      expectProcessed(await client.send(failed("e5", "pay_f")));
      expectIgnored(await client.send(captured("e6", "pay_f")));
      expectIgnored(await client.send(refunded("e7", "pay_f", 10)));
      await expectPayment(client, "pay_f", { status: "failed", amountMinor: 100, currency: "USD", feeMinor: null, refundedMinor: 0 });
      await expectNoLedger(client, "m_f");
    }));

  test("a capture with a different id after a capture is ignored and credits nothing more", () =>
    withWorld(async (world) => {
      // Bug caught: crediting per capture event instead of per payment state change.
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      expectIgnored(await client.send(captured("e3", "pay_1")));
      expectIgnored(await client.send(captured("e4", "pay_1")));
      await expectBalances(client, "m_a", { USD: 100 });
    }));

  test("all state is observable through one snapshot: a run of ignored events leaves it byte-identical", () =>
    withWorld(async (world) => {
      // Bug caught: ignored events that still touch stored data (e.g. overwriting amount or splits).
      const client = world.open();
      expectProcessed(await client.send(authorization()));
      expectProcessed(await client.send(captured("e2", "pay_1")));
      expectProcessed(await client.send(refunded("e3", "pay_1", 10)));
      const before = await snapshot(client, ["pay_1"], ["m_a", "m_b", "m_x"]);
      expectIgnored(await client.send(lateAuthorization()));
      expectIgnored(await client.send(captured("e5", "pay_1")));
      expectIgnored(await client.send(failed("e6", "pay_1")));
      expect(await snapshot(client, ["pay_1"], ["m_a", "m_b", "m_x"])).toEqual(before);
    }));
});
