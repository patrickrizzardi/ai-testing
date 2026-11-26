// Spec: Routing and Responses (Medium tier: one integration test per contract, table-driven for the listed paths).
import { describe, expect, test } from "bun:test";
import { authorized, captured, expectError, expectProcessed, signatureOf, split, toReply, withWorld } from "./support.ts";

describe("routing: unmatched paths answer 404 not_found", () => {
  const unmatched = [
    "/",
    "/nope",
    "/webhooks/",
    "/webhooks/extra",
    "/webhook",
    "/Webhooks",
    "/balances",
    "/balances/",
    "/balances/m_a/",
    "/balances/m_a/extra",
    "/payments",
    "/payments/",
    "/payments/pay_1/",
    "/payments/pay_1/refunds",
    "//webhooks",
  ];
  for (const path of unmatched) {
    test(`GET ${path}`, () =>
      withWorld(async (world) => {
        // Bug caught: prefix matching, trailing-slash tolerance, or an empty :id segment treated as a lookup.
        const client = world.open();
        expectError(await client.get(path), 404, "not_found");
      }));
  }

  test("POST to an unmatched path is 404, not 405, and is decided before the signature", () =>
    withWorld(async (world) => {
      // Bug caught: checking method/signature before routing.
      const client = world.open();
      expectError(await client.request("POST", "/nope"), 404, "not_found");
      expectError(await client.request("POST", "/webhooks/"), 404, "not_found");
    }));

  test("POST /webhooks/ with a valid signature is still 404 and has no effect", () =>
    withWorld(async (world) => {
      // Bug caught: normalising the trailing slash away.
      const client = world.open();
      const event = authorized("evt_slash", "pay_slash", 100, "USD");
      expectError(await client.send(event, { path: "/webhooks/" }), 404, "not_found");
      expectProcessed(await client.send(event));
    }));
});

describe("routing: matched path with another method answers 405 method_not_allowed", () => {
  const cases: [string, string][] = [
    ["GET", "/webhooks"],
    ["PUT", "/webhooks"],
    ["DELETE", "/webhooks"],
    ["PATCH", "/webhooks"],
    ["POST", "/balances/m_a"],
    ["PUT", "/balances/m_a"],
    ["DELETE", "/balances/m_a"],
    ["POST", "/payments/pay_1"],
    ["PATCH", "/payments/pay_1"],
    ["DELETE", "/payments/pay_1"],
  ];
  for (const [method, path] of cases) {
    test(`${method} ${path}`, () =>
      withWorld(async (world) => {
        // Bug caught: answering 404, 400 or 401 (signature) for a known path with the wrong method.
        const client = world.open();
        expectError(await client.request(method, path), 405, "method_not_allowed");
      }));
  }

  test("a 405 is answered before the body or signature is looked at", () =>
    withWorld(async (world) => {
      // Bug caught: verifying the signature of a PUT /webhooks before rejecting the method.
      const client = world.open();
      const raw = JSON.stringify(captured("evt_m", "pay_m"));
      const reply = await toReply(
        await client.app.fetch(
          new Request("http://localhost/webhooks", { method: "PUT", body: raw, headers: { "webhook-signature": `t=1,v1=${signatureOf("1", raw)}` } }),
        ),
      );
      expectError(reply, 405, "method_not_allowed");
    }));
});

describe("routing: path parameters and query strings", () => {
  test("the query string is ignored on every route", () =>
    withWorld(async (world) => {
      // Bug caught: matching on path + query, or reading the id from the query.
      const client = world.open();
      expectProcessed(await client.send(authorized("evt_q", "pay_q", 100, "USD", [split("m_q", 10000)]), { path: "/webhooks?source=test&x=1" }));
      expect((await client.get("/payments/pay_q?expand=all")).status).toBe(200);
      expect((await client.get("/balances/m_q?currency=USD")).status).toBe(404);
      expectError(await client.get("/nope?x=/balances/m_q"), 404, "not_found");
    }));

  test("ids are percent-decoded before use", () =>
    withWorld(async (world) => {
      // Bug caught: looking up the raw encoded segment ("pay%201") instead of the decoded id.
      const client = world.open();
      const paymentId = "pay 1/ü€";
      const merchantId = "m a/b";
      expectProcessed(await client.send(authorized("evt_p", paymentId, 100, "USD", [split(merchantId, 10000)])));
      expectProcessed(await client.send(captured("evt_p2", paymentId)));
      const payment = await client.get(`/payments/${encodeURIComponent(paymentId)}`);
      expect(payment.status).toBe(200);
      expect((payment.body as Record<string, unknown>).paymentId).toBe(paymentId);
      const balance = await client.get(`/balances/${encodeURIComponent(merchantId)}`);
      expect(balance.status).toBe(200);
      expect(balance.body).toEqual({ merchantId, balances: { USD: 100 } });
      // The undecoded spelling is a different id.
      expectError(await client.get("/payments/pay%201"), 404, "not_found");
    }));

  test("an encoded slash stays inside one segment", () =>
    withWorld(async (world) => {
      // Bug caught: decoding before splitting the path, so /balances/a%2Fb is read as two segments (404).
      const client = world.open();
      expectProcessed(await client.send(authorized("evt_slash2", "pay_s", 10, "USD", [split("a/b", 10000)])));
      expectProcessed(await client.send(captured("evt_slash3", "pay_s")));
      expect((await client.get("/balances/a%2Fb")).status).toBe(200);
    }));

  test("a malformed percent-escape in an id still resolves to a JSON error Response and never rejects", () =>
    withWorld(async (world) => {
      // Bug caught: decodeURIComponent throwing out of fetch (the contract says fetch never rejects).
      const client = world.open();
      const reply = await client.get("/balances/%E0%A4%A");
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expectError(reply, reply.status, (reply.body as Record<string, string>).code as string);
    }));
});

describe("responses: shape of every non-2xx", () => {
  test("every error carries Content-Type application/json and exactly { code, message }", () =>
    withWorld(async (world) => {
      // Bug caught: an error path (404/405/401/400/409/422) leaking a text/plain body or extra keys such as `details`/`stack`.
      const client = world.open();
      expectError(await client.get("/nope"), 404, "not_found");
      expectError(await client.request("PUT", "/webhooks"), 405, "method_not_allowed");
      expectError(await client.send("{", { secret: "x" }), 401, "invalid_signature");
      expectError(await client.send("{"), 400, "invalid_input");
      expectProcessed(await client.send(authorized("evt_e", "pay_e", 10, "USD")));
      expectError(await client.send(authorized("evt_e", "pay_e", 11, "USD")), 409, "event_conflict");
      expectError(await client.send(authorized("evt_e2", "pay_e", 10, "GBP")), 422, "unsupported_currency");
      expectError(await client.get("/balances/nobody"), 404, "not_found");
      expectError(await client.get("/payments/nobody"), 404, "not_found");
    }));
});
