// Spec: POST /webhooks, step 2 "Body" (High tier: validation of untrusted input) and its place in the order of steps.
import { describe, test } from "bun:test";
import {
  type EventBody,
  type Reply,
  type SplitInput,
  authorized,
  captured,
  expectDeferred,
  expectError,
  expectNoPayment,
  expectProcessed,
  failed,
  refunded,
  split,
  withWorld,
} from "./support.ts";

type Body = EventBody | string;
const dataOf = (event: EventBody) => event.data as Record<string, unknown>;
const HALVES: SplitInput[] = [split("m_a", 5000), split("m_b", 5000)];

const baseAuthorized = (): EventBody => authorized("evt_v", "pay_v", 100, "USD", HALVES);
const baseCaptured = (): EventBody => captured("evt_v", "pay_v");
const baseFailed = (): EventBody => failed("evt_v", "pay_v");
const baseRefunded = (): EventBody => refunded("evt_v", "pay_v", 10, "ref_v");

/** Edits one field of a copy of `base`; `value` of `undefined` removes the key. */
function withField(base: () => EventBody, path: string[], value: unknown): () => EventBody {
  return () => {
    const event = base();
    let target: Record<string, unknown> = event;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
    const last = path[path.length - 1] as string;
    if (value === undefined) delete target[last];
    else target[last] = value;
    return event;
  };
}
/** Replaces text in the serialised event, to write number literals JSON.stringify cannot produce. */
const withText = (base: () => EventBody, from: string, to: string) => (): string => {
  const raw = JSON.stringify(base());
  if (!raw.includes(from)) throw new Error(`test setup: ${from} not found in ${raw}`);
  return raw.replace(from, to);
};

/** After any rejection the id must be unusable-free: a valid event under the same id is new. */
async function expectIdStillUnused(client: { send(body: Body): Promise<Reply> }): Promise<void> {
  expectProcessed(await client.send(baseAuthorized()));
}

const badRequests: [string, () => Body][] = [
  // --- whole body ---
  ["body empty", () => ""],
  ["body not JSON", () => "{"],
  ["body is an array", () => "[]"],
  ["body is a string", () => '"payment.captured"'],
  ["body is null", () => "null"],
  ["body is a number", () => "42"],
  ["body is valid JSON followed by garbage", () => `${JSON.stringify(baseAuthorized())} x`],
  ["body is two JSON documents", () => `${JSON.stringify(baseAuthorized())}${JSON.stringify(baseAuthorized())}`],
  // --- id ---
  ["id missing", withField(baseAuthorized, ["id"], undefined)],
  ["id empty", withField(baseAuthorized, ["id"], "")],
  ["id a number", withField(baseAuthorized, ["id"], 7)],
  ["id null", withField(baseAuthorized, ["id"], null)],
  ["id an object", withField(baseAuthorized, ["id"], { v: 1 })],
  // --- type ---
  ["type missing", withField(baseAuthorized, ["type"], undefined)],
  ["type unknown", withField(baseAuthorized, ["type"], "payment.created")],
  ["type empty", withField(baseAuthorized, ["type"], "")],
  ["type wrong case", withField(baseAuthorized, ["type"], "Payment.Authorized")],
  ["type a number", withField(baseAuthorized, ["type"], 1)],
  ["type null", withField(baseAuthorized, ["type"], null)],
  // --- createdAt (shape only; the calendar table is below) ---
  ["createdAt missing", withField(baseAuthorized, ["createdAt"], undefined)],
  ["createdAt a number", withField(baseAuthorized, ["createdAt"], 1700000000)],
  ["createdAt null", withField(baseAuthorized, ["createdAt"], null)],
  // --- data ---
  ["data missing", withField(baseAuthorized, ["data"], undefined)],
  ["data null", withField(baseAuthorized, ["data"], null)],
  ["data an array", withField(baseAuthorized, ["data"], [])],
  ["data a string", withField(baseAuthorized, ["data"], "x")],
  ["data a number", withField(baseAuthorized, ["data"], 1)],
  // --- authorized: paymentId, amountMinor, currency ---
  ["authorized: paymentId missing", withField(baseAuthorized, ["data", "paymentId"], undefined)],
  ["authorized: paymentId empty", withField(baseAuthorized, ["data", "paymentId"], "")],
  ["authorized: paymentId a number", withField(baseAuthorized, ["data", "paymentId"], 5)],
  ["authorized: paymentId null", withField(baseAuthorized, ["data", "paymentId"], null)],
  ["authorized: amountMinor missing", withField(baseAuthorized, ["data", "amountMinor"], undefined)],
  ["authorized: amountMinor 0", withField(baseAuthorized, ["data", "amountMinor"], 0)],
  ["authorized: amountMinor negative", withField(baseAuthorized, ["data", "amountMinor"], -1)],
  ["authorized: amountMinor fractional", withField(baseAuthorized, ["data", "amountMinor"], 1.5)],
  ["authorized: amountMinor a numeric string", withField(baseAuthorized, ["data", "amountMinor"], "100")],
  ["authorized: amountMinor null", withField(baseAuthorized, ["data", "amountMinor"], null)],
  ["authorized: amountMinor a boolean", withField(baseAuthorized, ["data", "amountMinor"], true)],
  ["authorized: amountMinor 2^53 (above the safe-integer range)", withText(baseAuthorized, '"amountMinor":100', '"amountMinor":9007199254740992')],
  ["authorized: amountMinor 1e20", withText(baseAuthorized, '"amountMinor":100', '"amountMinor":1e20')],
  ["authorized: amountMinor 0.0", withText(baseAuthorized, '"amountMinor":100', '"amountMinor":0.0')],
  ["authorized: amountMinor 100.5 written with an exponent", withText(baseAuthorized, '"amountMinor":100', '"amountMinor":1.005e2')],
  ["authorized: currency missing", withField(baseAuthorized, ["data", "currency"], undefined)],
  ["authorized: currency a number", withField(baseAuthorized, ["data", "currency"], 840)],
  ["authorized: currency null", withField(baseAuthorized, ["data", "currency"], null)],
  ["authorized: currency an array", withField(baseAuthorized, ["data", "currency"], ["USD"])],
  ["authorized: currency an object", withField(baseAuthorized, ["data", "currency"], { code: "USD" })],
  // --- authorized: splits ---
  ["splits missing", withField(baseAuthorized, ["data", "splits"], undefined)],
  ["splits null", withField(baseAuthorized, ["data", "splits"], null)],
  ["splits an object", withField(baseAuthorized, ["data", "splits"], { m_a: 10000 })],
  ["splits a string", withField(baseAuthorized, ["data", "splits"], "m_a")],
  ["splits empty", withField(baseAuthorized, ["data", "splits"], [])],
  [
    "splits 11 entries (weights sum 10000)",
    withField(baseAuthorized, ["data", "splits"], [...Array.from({ length: 10 }, (_, index) => split(`m_${index}`, 900)), split("m_10", 1000)]),
  ],
  ["splits sum 9999", withField(baseAuthorized, ["data", "splits"], [split("m_a", 5000), split("m_b", 4999)])],
  ["splits sum 10001", withField(baseAuthorized, ["data", "splits"], [split("m_a", 5000), split("m_b", 5001)])],
  ["splits single weight 9999", withField(baseAuthorized, ["data", "splits"], [split("m_a", 9999)])],
  ["splits weight negative (sum still 10000)", withField(baseAuthorized, ["data", "splits"], [split("m_a", 10001), split("m_b", -1)])],
  ["splits weight fractional (sum 10000)", withField(baseAuthorized, ["data", "splits"], [split("m_a", 5000.5), split("m_b", 4999.5)])],
  ["splits weight a numeric string", withField(baseAuthorized, ["data", "splits"], [{ merchantId: "m_a", weightBps: "10000" }])],
  ["splits weight missing", withField(baseAuthorized, ["data", "splits"], [{ merchantId: "m_a" }])],
  ["splits weight null", withField(baseAuthorized, ["data", "splits"], [{ merchantId: "m_a", weightBps: null }])],
  ["splits merchantId missing", withField(baseAuthorized, ["data", "splits"], [{ weightBps: 10000 }])],
  ["splits merchantId empty", withField(baseAuthorized, ["data", "splits"], [split("", 10000)])],
  ["splits merchantId a number", withField(baseAuthorized, ["data", "splits"], [{ merchantId: 1, weightBps: 10000 }])],
  ["splits merchantId repeated", withField(baseAuthorized, ["data", "splits"], [split("m_a", 5000), split("m_a", 5000)])],
  ["splits merchantId repeated, one weight 0", withField(baseAuthorized, ["data", "splits"], [split("m_a", 0), split("m_a", 10000)])],
  ["splits entry null", withField(baseAuthorized, ["data", "splits"], [null])],
  ["splits entry a string", withField(baseAuthorized, ["data", "splits"], ["m_a"])],
  ["splits entry an array", withField(baseAuthorized, ["data", "splits"], [["m_a", 10000]])],
  // --- captured / failed ---
  ["captured: paymentId missing", withField(baseCaptured, ["data", "paymentId"], undefined)],
  ["captured: paymentId empty", withField(baseCaptured, ["data", "paymentId"], "")],
  ["captured: paymentId a number", withField(baseCaptured, ["data", "paymentId"], 5)],
  ["captured: paymentId null", withField(baseCaptured, ["data", "paymentId"], null)],
  ["failed: paymentId missing", withField(baseFailed, ["data", "paymentId"], undefined)],
  ["failed: paymentId empty", withField(baseFailed, ["data", "paymentId"], "")],
  ["failed: paymentId a number", withField(baseFailed, ["data", "paymentId"], 5)],
  // --- refunded ---
  ["refunded: paymentId missing", withField(baseRefunded, ["data", "paymentId"], undefined)],
  ["refunded: paymentId empty", withField(baseRefunded, ["data", "paymentId"], "")],
  ["refunded: refundId missing", withField(baseRefunded, ["data", "refundId"], undefined)],
  ["refunded: refundId empty", withField(baseRefunded, ["data", "refundId"], "")],
  ["refunded: refundId a number", withField(baseRefunded, ["data", "refundId"], 9)],
  ["refunded: amountMinor missing", withField(baseRefunded, ["data", "amountMinor"], undefined)],
  ["refunded: amountMinor 0", withField(baseRefunded, ["data", "amountMinor"], 0)],
  ["refunded: amountMinor negative", withField(baseRefunded, ["data", "amountMinor"], -5)],
  ["refunded: amountMinor fractional", withField(baseRefunded, ["data", "amountMinor"], 2.5)],
  ["refunded: amountMinor a string", withField(baseRefunded, ["data", "amountMinor"], "10")],
  ["refunded: amountMinor above the safe-integer range", withText(baseRefunded, '"amountMinor":10', '"amountMinor":9007199254740992')],
];

// The body is already invalid in a second way, so the 422 case must not fire: 400 wins.
const invalidCurrencyButAlsoBad: [string, () => EventBody][] = [
  ["amountMinor 0", withField(withField(baseAuthorized, ["data", "currency"], "XXX"), ["data", "amountMinor"], 0)],
  ["splits sum 9999", withField(withField(baseAuthorized, ["data", "currency"], "XXX"), ["data", "splits"], [split("m_a", 9999)])],
  ["paymentId missing", withField(withField(baseAuthorized, ["data", "currency"], "XXX"), ["data", "paymentId"], undefined)],
  ["createdAt malformed", withField(withField(baseAuthorized, ["data", "currency"], "XXX"), ["createdAt"], "yesterday")],
  ["id empty", withField(withField(baseAuthorized, ["data", "currency"], "XXX"), ["id"], "")],
];

const unsupportedCurrencies = ["usd", "Usd", "eur", "GBP", "", "USD ", " USD", "JPY\n", "BTC", "XXX"];

describe("validation: 400 invalid_input", () => {
  for (const [name, build] of badRequests) {
    test(`rejects: ${name}`, () =>
      withWorld(async (world) => {
        // Bug caught: a missing/loose check, or a crash (500) on the malformed shape.
        const client = world.open();
        expectError(await client.send(build()), 400, "invalid_input");
        await expectNoPayment(client, "pay_v");
        await expectIdStillUnused(client);
      }));
  }

  for (const [name, build] of invalidCurrencyButAlsoBad) {
    test(`unsupported currency + ${name} answers 400, not 422`, () =>
      withWorld(async (world) => {
        // Bug caught: checking the currency before the other 400 checks; the spec orders 422 after all of them.
        const client = world.open();
        expectError(await client.send(build()), 400, "invalid_input");
      }));
  }
});

describe("validation: 422 unsupported_currency", () => {
  for (const currency of unsupportedCurrencies) {
    test(`currency ${JSON.stringify(currency)} is not supported`, () =>
      withWorld(async (world) => {
        // Bug caught: case-insensitive or trimmed currency matching; open-ended currency strings.
        const client = world.open();
        expectError(await client.send(authorized("evt_v", "pay_v", 100, currency, HALVES)), 422, "unsupported_currency");
        await expectNoPayment(client, "pay_v");
        await expectIdStillUnused(client);
      }));
  }
});

describe("validation: createdAt calendar and shape", () => {
  const invalid = [
    "2023-11-14t22:13:20Z",
    "2023-11-14T22:13:20z",
    "2023-11-14T22:13:20",
    "2023-11-14",
    "2023-11-14 22:13:20Z",
    "2023-13-14T22:13:20Z",
    "2023-00-14T22:13:20Z",
    "2023-11-00T22:13:20Z",
    "2023-11-31T22:13:20Z",
    "2023-04-31T22:13:20Z",
    "2023-02-29T22:13:20Z",
    "1900-02-29T22:13:20Z",
    "2023-02-30T22:13:20Z",
    "2023-11-14T24:00:00Z",
    "2023-11-14T22:60:20Z",
    "2023-11-14T22:13:60Z",
    "2023-11-14T22:13:20+24:00",
    "2023-11-14T22:13:20-24:00",
    "2023-11-14T22:13:20+01:60",
    "2023-11-14T22:13:20+0100",
    "2023-11-14T22:13:20+01",
    "2023-11-14T22:13:20.Z",
    "2023-11-14T22:13:20.123",
    "2023-11-14T22:13Z",
    "2023-1-14T22:13:20Z",
    "2023-11-14T2:13:20Z",
    "20231114T221320Z",
    " 2023-11-14T22:13:20Z",
    "2023-11-14T22:13:20Z ",
    "2023-11-14T22:13:20Z\n",
    "",
    "now",
  ];
  for (const createdAt of invalid) {
    test(`rejects createdAt ${JSON.stringify(createdAt)}`, () =>
      withWorld(async (world) => {
        // Bug caught: Date.parse() leniency or a regex without calendar checks (Feb 30, hour 24, second 60...).
        const client = world.open();
        expectError(await client.send(withField(baseAuthorized, ["createdAt"], createdAt)()), 400, "invalid_input");
        await expectIdStillUnused(client);
      }));
  }

  const valid = [
    "2023-11-14T22:13:20Z",
    "2023-11-14T22:13:20.1Z",
    "2023-11-14T22:13:20.123456789Z",
    "2023-11-14T22:13:20+00:00",
    "2023-11-14T22:13:20-00:00",
    "2023-11-14T22:13:20+23:59",
    "2023-11-14T22:13:20-05:30",
    "2023-11-14T22:13:20.5+05:45",
    "2024-02-29T00:00:00Z",
    "2000-02-29T12:00:00Z",
    "2023-02-28T23:59:59Z",
    "2023-04-30T23:59:59Z",
    "2023-12-31T23:59:59.999Z",
    "2023-01-01T00:00:00Z",
  ];
  for (const createdAt of valid) {
    test(`accepts createdAt ${JSON.stringify(createdAt)}`, () =>
      withWorld(async (world) => {
        // Bug caught: over-strict date validation rejecting leap days, fractions or offsets the spec allows.
        const client = world.open();
        expectProcessed(await client.send(withField(baseAuthorized, ["createdAt"], createdAt)()));
      }));
  }
});

describe("validation: boundary values that are accepted", () => {
  test("amountMinor 9007199254740991 (largest) is accepted and stored exactly", () =>
    withWorld(async (world) => {
      // Bug caught: rejecting or rounding the largest safe integer.
      const client = world.open();
      expectProcessed(await client.send(withText(baseAuthorized, '"amountMinor":100', '"amountMinor":9007199254740991')()));
      const payment = await client.payment("pay_v");
      if ((payment.body as Record<string, unknown>).amountMinor !== 9007199254740991) throw new Error(`stored ${JSON.stringify(payment.body)}`);
    }));

  const acceptedAmounts: [string, string][] = [
    ["1", "1"],
    ["100.0", "100.0"],
    ["1e2", "1e2"],
    ["1.0E+2", "1.0E+2"],
  ];
  for (const [name, literal] of acceptedAmounts) {
    test(`amountMinor written as ${name} is a whole number by value and is accepted`, () =>
      withWorld(async (world) => {
        // Bug caught: judging integers by their text instead of their value ("Integer means a JSON number whose value is whole").
        const client = world.open();
        expectProcessed(await client.send(withText(baseAuthorized, '"amountMinor":100', `"amountMinor":${literal}`)()));
      }));
  }

  for (const currency of ["USD", "EUR", "JPY", "BHD"]) {
    test(`currency ${currency} is supported`, () =>
      withWorld(async (world) => {
        // Bug caught: a currency missing from the supported list.
        const client = world.open();
        expectProcessed(await client.send(authorized("evt_c", "pay_c", 100, currency)));
      }));
  }

  test("splits: exactly 10 entries is accepted", () =>
    withWorld(async (world) => {
      // Bug caught: off-by-one on the 1..10 entry bound.
      const client = world.open();
      const splits = Array.from({ length: 10 }, (_, index) => split(`m_${index}`, 1000));
      expectProcessed(await client.send(authorized("evt_s", "pay_s", 100, "USD", splits)));
    }));

  test("splits: one entry of 10000, and a weight of 0 next to 10000, are accepted", () =>
    withWorld(async (world) => {
      // Bug caught: requiring weights > 0 or at least two splits.
      const client = world.open();
      expectProcessed(await client.send(authorized("evt_s1", "pay_s1", 100, "USD", [split("m_a", 10000)])));
      expectProcessed(await client.send(authorized("evt_s2", "pay_s2", 100, "USD", [split("m_a", 0), split("m_b", 10000)])));
    }));

  test("fields not listed in the spec are allowed at the top level, in data, and are ignored", () =>
    withWorld(async (world) => {
      // Bug caught: strict schemas that reject unknown keys.
      const client = world.open();
      const event = baseAuthorized();
      event.livemode = true;
      event.apiVersion = "2023-01-01";
      dataOf(event).description = "ignored";
      expectProcessed(await client.send(event));
      const capture = baseCaptured();
      capture.id = "evt_extra_capture";
      dataOf(capture).amountMinor = "not a number, but not for capture";
      dataOf(capture).currency = 42;
      expectProcessed(await client.send(capture));
    }));

  test("a refund and a failure with extra data fields are validated only on the listed fields", () =>
    withWorld(async (world) => {
      // Bug caught: validating authorize-only fields (amount, currency, splits) on every event type.
      const client = world.open();
      expectDeferred(await client.send(withField(baseFailed, ["data", "splits"], "junk")()));
      const refund = baseRefunded();
      refund.id = "evt_r";
      dataOf(refund).currency = "NOPE";
      expectDeferred(await client.send(refund));
    }));
});

describe("validation: position in the order of steps", () => {
  const afterRecording: [string, () => Body, number, string][] = [
    ["a body that is not JSON", () => "{", 400, "invalid_input"],
    ["an invalid amount", withField(baseAuthorized, ["data", "amountMinor"], 0), 400, "invalid_input"],
    ["an unsupported currency", withField(baseAuthorized, ["data", "currency"], "usd"), 422, "unsupported_currency"],
    ["an unsupported currency in a body that differs from the recorded one", withField(baseAuthorized, ["data", "currency"], "GBP"), 422, "unsupported_currency"],
  ];
  for (const [name, build, status, code] of afterRecording) {
    test(`id already recorded + ${name}: validation answers first (${status} ${code}), never 409 or duplicate`, () =>
      withWorld(async (world) => {
        // Bug caught: idempotency lookup before validation (a bad body would be answered 409/duplicate).
        const client = world.open();
        expectProcessed(await client.send(baseAuthorized()));
        const raw = build();
        expectError(await client.send(raw), status, code);
      }));
  }

  test("a 400 or 422 rejection does not record the id: the same id later carries a different valid body without conflict", () =>
    withWorld(async (world) => {
      // Bug caught: recording the event id before validation finishes.
      const client = world.open();
      expectError(await client.send(withField(baseAuthorized, ["data", "amountMinor"], -1)()), 400, "invalid_input");
      expectError(await client.send(withField(baseAuthorized, ["data", "currency"], "GBP")()), 422, "unsupported_currency");
      expectProcessed(await client.send(authorized("evt_v", "pay_v", 777, "EUR", HALVES)));
    }));
});
