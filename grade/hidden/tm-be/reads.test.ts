// Spec: Reads (GET /balances/:merchantId, GET /payments/:paymentId). Medium tier: shape, 404s, no signature needed.
import { describe, expect, test } from "bun:test";
import {
  THIRDS,
  authorized,
  captured,
  expectError,
  expectJsonContentType,
  expectProcessed,
  failed,
  feesOf,
  refunded,
  split,
  withWorld,
} from "./support.ts";

describe("reads: GET /payments/:paymentId", () => {
  test("shape per status: authorized, captured (with refund), failed", () =>
    withWorld(async (world) => {
      // Bug caught: wrong key set/names, feeMinor 0 instead of null before capture, refundedMinor missing or null.
      const client = world.open({ fees: feesOf(1000, { USD: 17 }) });
      expectProcessed(await client.send(authorized("e1", "pay_1", 131, "USD", THIRDS)));
      let reply = await client.payment("pay_1");
      expect(reply.status).toBe(200);
      expectJsonContentType(reply);
      expect(reply.body).toEqual({ paymentId: "pay_1", status: "authorized", amountMinor: 131, currency: "USD", feeMinor: null, refundedMinor: 0 });
      expect(Object.keys(reply.body as object).sort()).toEqual(["amountMinor", "currency", "feeMinor", "paymentId", "refundedMinor", "status"]);

      expectProcessed(await client.send(captured("e2", "pay_1")));
      reply = await client.payment("pay_1");
      expect(reply.body).toEqual({ paymentId: "pay_1", status: "captured", amountMinor: 131, currency: "USD", feeMinor: 30, refundedMinor: 0 });

      expectProcessed(await client.send(refunded("e3", "pay_1", 50)));
      reply = await client.payment("pay_1");
      expect(reply.body).toEqual({ paymentId: "pay_1", status: "captured", amountMinor: 131, currency: "USD", feeMinor: 30, refundedMinor: 50 });

      expectProcessed(await client.send(authorized("e4", "pay_2", 20, "EUR")));
      expectProcessed(await client.send(failed("e5", "pay_2")));
      reply = await client.payment("pay_2");
      expect(reply.body).toEqual({ paymentId: "pay_2", status: "failed", amountMinor: 20, currency: "EUR", feeMinor: null, refundedMinor: 0 });
    }));

  test("captured with a fee of 0 reports feeMinor 0, not null", () =>
    withWorld(async (world) => {
      // Bug caught: using falsy checks, so a zero fee reads as "not captured yet".
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_z", 100, "USD")));
      expectProcessed(await client.send(captured("e2", "pay_z")));
      expect((await client.payment("pay_z")).body).toEqual({ paymentId: "pay_z", status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 0 });
    }));

  test("unknown payment is 404, and so is a payment that only has deferred events", () =>
    withWorld(async (world) => {
      // Bug caught: exposing a placeholder payment created by a deferred event.
      const client = world.open();
      expectError(await client.payment("pay_none"), 404, "not_found");
      expect((await client.send(captured("e1", "pay_def"))).status).toBe(202);
      expect((await client.send(refunded("e2", "pay_def", 5))).status).toBe(202);
      expectError(await client.payment("pay_def"), 404, "not_found");
    }));

});

describe("reads: GET /balances/:merchantId", () => {
  test("one key per currency in which the merchant has a ledger entry, including negative and zero", () =>
    withWorld(async (world) => {
      // Bug caught: hiding zero or negative balances, or reporting a fixed currency set with zeros.
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_u", 100, "USD", [split("m_x", 10000)])));
      expectProcessed(await client.send(authorized("e2", "pay_j", 100, "JPY", [split("m_x", 10000)])));
      expectProcessed(await client.send(captured("e3", "pay_u")));
      let reply = await client.balance("m_x");
      expect(reply.status).toBe(200);
      expectJsonContentType(reply);
      expect(reply.body).toEqual({ merchantId: "m_x", balances: { USD: 100 } });
      expectProcessed(await client.send(captured("e4", "pay_j")));
      expect((await client.balance("m_x")).body).toEqual({ merchantId: "m_x", balances: { USD: 100, JPY: 100 } });
      expectProcessed(await client.send(refunded("e5", "pay_u", 100)));
      expectProcessed(await client.send(refunded("e6", "pay_j", 100)));
      reply = await client.balance("m_x");
      expect(reply.body).toEqual({ merchantId: "m_x", balances: { USD: 0, JPY: 0 } });
    }));

  test("a merchant that only appears in splits of uncaptured or failed payments has no ledger entry (404)", () =>
    withWorld(async (world) => {
      // Bug caught: creating ledger rows at authorization instead of at capture.
      const client = world.open();
      expectProcessed(await client.send(authorized("e1", "pay_a", 100, "USD", [split("m_only_auth", 10000)])));
      expectProcessed(await client.send(authorized("e2", "pay_f", 100, "USD", [split("m_only_failed", 10000)])));
      expectProcessed(await client.send(failed("e3", "pay_f")));
      expectError(await client.balance("m_only_auth"), 404, "not_found");
      expectError(await client.balance("m_only_failed"), 404, "not_found");
      expectError(await client.balance("m_nobody"), 404, "not_found");
    }));

});
