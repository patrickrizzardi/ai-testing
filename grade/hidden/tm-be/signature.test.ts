// Spec: POST /webhooks, step 1 "Signature" (High tier: authentication of untrusted input).
import { describe, expect, test } from "bun:test";
import {
  SIGNED_AT_SECONDS,
  authorized,
  captured,
  createApp,
  expectDeferred,
  expectError,
  expectProcessed,
  newWorld,
  signatureOf,
  toReply,
  webhookRequest,
  withWorld,
  ZERO_FEES,
} from "./support.ts";

const SIGNED_AT = String(SIGNED_AT_SECONDS);
const RAW = JSON.stringify(captured("evt_sig", "pay_sig"));
const GOOD = signatureOf(SIGNED_AT, RAW);

describe("signature: accepted", () => {
  test("worked example from the spec is accepted with its exact header", async () => {
    // Bug caught: signing a different string than "<t>.<raw body>" or a different key/encoding than the spec's.
    const world = newWorld();
    try {
      const raw = '{"id":"evt_1","type":"payment.captured","createdAt":"2023-11-14T22:13:20Z","data":{"paymentId":"pay_1"}}';
      const app = createApp({ dbPath: world.dbPath, secret: "whsec_example", fees: ZERO_FEES, now: () => new Date(1_700_000_000_000) });
      const request = webhookRequest("http://localhost", raw, {
        header: "t=1700000000,v1=c4774e8bfe5b84c1dee1146183d174d483187b06388692e3c6d912805c0ad8ea",
      }, SIGNED_AT);
      try {
        expectDeferred(await toReply(await app.fetch(request)));
      } finally {
        app.close();
      }
    } finally {
      world.cleanup();
    }
  });

  test("signature is computed over the raw bytes, not a re-serialisation of the parsed JSON", () =>
    withWorld(async (world) => {
      // Bug caught: verifying HMAC(JSON.stringify(JSON.parse(body))) instead of the body exactly as received.
      const client = world.open();
      const raw = `{\n  "type" : "payment.captured",\n  "id":"evt_raw",\n\t"createdAt":"${"2023-11-14T22:13:20Z"}",\n  "note": "héllo 日本 😀 \\u0041",\n  "data":{ "paymentId" : "pay_raw" }\n}`;
      expectDeferred(await client.send(raw));
    }));

  test("signed digits are used exactly as written, leading zeros included", () =>
    withWorld(async (world) => {
      // Bug caught: parsing t to a number and signing String(number), which drops leading zeros.
      const client = world.open();
      expectDeferred(await client.send(captured("evt_zero", "pay_zero"), { signedAt: "01700000000" }));
    }));
});

describe("signature: rejected as invalid_signature", () => {
  test("wrong secret", () =>
    withWorld(async (world) => {
      // Bug caught: not verifying, or verifying against a fixed/default key.
      const client = world.open();
      expectError(await client.send(RAW, { secret: "whsec_other" }), 401, "invalid_signature");
    }));

  test("the app's secret is used as UTF-8 bytes (non-ASCII secret)", () =>
    withWorld(async (world) => {
      // Bug caught: encoding the key as latin1/hex/base64 instead of UTF-8 bytes.
      const secret = "sécrét-日本-🔑";
      const client = world.open({ secret });
      expectDeferred(await client.send(RAW, { secret }));
      expectError(await client.send(RAW, { secret: "secret-ascii" }), 401, "invalid_signature");
    }));

  test("tampered body", () =>
    withWorld(async (world) => {
      // Bug caught: accepting a signature that belongs to another body.
      const client = world.open();
      const tampered = RAW.replace("pay_sig", "pay_sih");
      const signedForOriginal = `t=${SIGNED_AT},v1=${GOOD}`;
      expectError(await client.send(tampered, { header: signedForOriginal }), 401, "invalid_signature");
    }));

  test("body differing only by added whitespace", () =>
    withWorld(async (world) => {
      // Bug caught: verifying over a normalised/trimmed body.
      const client = world.open();
      expectError(await client.send(`${RAW} `, { header: `t=${SIGNED_AT},v1=${GOOD}` }), 401, "invalid_signature");
    }));

  test("signature made for a different t than the header's t", () =>
    withWorld(async (world) => {
      // Bug caught: leaving t out of the signed string.
      const client = world.open();
      const otherT = String(SIGNED_AT_SECONDS + 1);
      expectError(await client.send(RAW, { header: `t=${otherT},v1=${GOOD}` }), 401, "invalid_signature");
    }));

  const lowercaseHexOfOtherBody = signatureOf(SIGNED_AT, "other");
  const malformedHeaders: [string, string | null][] = [
    ["header missing", null],
    ["header empty", ""],
    ["parts in reverse order", `v1=${GOOD},t=${SIGNED_AT}`],
    ["space after the comma", `t=${SIGNED_AT}, v1=${GOOD}`],
    ["extra part after v1", `t=${SIGNED_AT},v1=${GOOD},v0=abc`],
    ["trailing comma", `t=${SIGNED_AT},v1=${GOOD},`],
    ["double comma", `t=${SIGNED_AT},,v1=${GOOD}`],
    ["semicolon separator", `t=${SIGNED_AT};v1=${GOOD}`],
    ["repeated t part", `t=${SIGNED_AT},t=${SIGNED_AT},v1=${GOOD}`],
    ["t only", `t=${SIGNED_AT}`],
    ["v1 only", `v1=${GOOD}`],
    ["t without digits", `t=,v1=${GOOD}`],
    ["t with a sign", `t=+${SIGNED_AT},v1=${GOOD}`],
    ["t with a fraction", `t=${SIGNED_AT}.5,v1=${GOOD}`],
    ["t not numeric", `t=abc,v1=${GOOD}`],
    ["upper-case key names", `T=${SIGNED_AT},V1=${GOOD}`],
    ["v1 empty", `t=${SIGNED_AT},v1=`],
    ["v1 one character short", `t=${SIGNED_AT},v1=${GOOD.slice(1)}`],
    ["v1 one character long", `t=${SIGNED_AT},v1=${GOOD}0`],
    ["v1 with a non-hex character", `t=${SIGNED_AT},v1=g${GOOD.slice(1)}`],
    ["v1 with a scheme prefix", `t=${SIGNED_AT},v1=sha256=${GOOD}`],
    ["v1 of a different body", `t=${SIGNED_AT},v1=${lowercaseHexOfOtherBody}`],
  ];
  for (const [name, header] of malformedHeaders) {
    test(`header shape: ${name}`, () =>
      withWorld(async (world) => {
        // Bug caught: a lenient header parser that accepts a shape the spec forbids (or crashes with 500/400).
        const client = world.open();
        expectError(await client.send(RAW, { header }), 401, "invalid_signature");
        // A rejected request has no effect: the same event, properly signed, is new.
        expectDeferred(await client.send(RAW));
      }));
  }

  test("valid HMAC written in upper-case hex is not the required lowercase form", () =>
    withWorld(async (world) => {
      // Bug caught: case-insensitive hex comparison; the spec demands 64 lowercase characters.
      const client = world.open();
      expectError(await client.send(RAW, { header: `t=${SIGNED_AT},v1=${GOOD.toUpperCase()}` }), 401, "invalid_signature");
    }));

  test("t of 16 digits is a malformed header even when correctly signed", () =>
    withWorld(async (world) => {
      // Bug caught: not enforcing the 1..15 digit bound (and answering stale_signature instead).
      const client = world.open();
      expectError(await client.send(RAW, { signedAt: "1700000000000000" }), 401, "invalid_signature");
    }));

  test("wrong signature with a stale t answers invalid_signature, not stale_signature", () =>
    withWorld(async (world) => {
      // Bug caught: checking freshness before the signature (reveals timing info to unsigned callers).
      const client = world.open();
      world.clock.ms += 10_000_000;
      expectError(await client.send(RAW, { secret: "whsec_other" }), 401, "invalid_signature");
    }));
});

describe("signature: freshness window", () => {
  const offsets: [string, number, "accepted" | "stale_signature"][] = [
    ["now = t exactly", 0, "accepted"],
    ["now = t + 300 s is accepted", 300_000, "accepted"],
    ["now = t - 300 s is accepted", -300_000, "accepted"],
    ["now = t + 299.999 s is accepted", 299_999, "accepted"],
    ["now = t + 301 s is stale", 301_000, "stale_signature"],
    ["now = t - 301 s is stale", -301_000, "stale_signature"],
    ["now = t + 300.001 s is stale (fractions are kept)", 300_001, "stale_signature"],
    ["now = t - 300.001 s is stale (fractions are kept)", -300_001, "stale_signature"],
  ];
  for (const [name, offsetMs, expected] of offsets) {
    test(name, () =>
      withWorld(async (world) => {
        // Bug caught: off-by-one at the boundary (>= vs >), floor/round of now, one-sided window, or the real clock.
        const client = world.open();
        world.clock.ms = SIGNED_AT_SECONDS * 1000 + offsetMs;
        const reply = await client.send(RAW, { signedAt: SIGNED_AT });
        if (expected === "accepted") expectDeferred(reply);
        else expectError(reply, 401, "stale_signature");
      }));
  }

  test("a 15-digit t and t=0 are well-formed, so a correct signature on them is stale rather than invalid", () =>
    withWorld(async (world) => {
      // Bug caught: wrong digit bounds on t (14 or 16 allowed) and mixing up the two 401 codes.
      const client = world.open();
      expectError(await client.send(RAW, { signedAt: "999999999999999" }), 401, "stale_signature");
      expectError(await client.send(RAW, { signedAt: "0" }), 401, "stale_signature");
    }));

  test("t leading zeros are compared numerically for freshness", () =>
    withWorld(async (world) => {
      // Bug caught: treating "01700000000" as octal or as a string.
      const client = world.open();
      world.clock.ms = (SIGNED_AT_SECONDS + 300) * 1000;
      expectDeferred(await client.send(RAW, { signedAt: "01700000000" }));
      world.clock.ms = (SIGNED_AT_SECONDS + 301) * 1000;
      expectError(await client.send(RAW, { signedAt: "01700000000" }), 401, "stale_signature");
    }));

  test("a stale request has no effect and its event id stays unused", () =>
    withWorld(async (world) => {
      // Bug caught: recording the event before the freshness check.
      const client = world.open();
      const event = captured("evt_stale", "pay_stale");
      expectError(await client.send(event, { signedAt: String(SIGNED_AT_SECONDS - 1000) }), 401, "stale_signature");
      expectDeferred(await client.send(event));
    }));
});

describe("signature: checked before the body is parsed", () => {
  const notJson = "{ this is not json";

  test("valid signature + non-JSON body answers 400 (control for the next tests)", () =>
    withWorld(async (world) => {
      // Bug caught: signature handling that cannot sign an arbitrary body.
      const client = world.open();
      expectError(await client.send(notJson), 400, "invalid_input");
    }));

  test("wrong signature + non-JSON body answers 401 invalid_signature, never 400", () =>
    withWorld(async (world) => {
      // Bug caught: parsing/validating the body before the signature (leaks body validity to unsigned callers).
      const client = world.open();
      expectError(await client.send(notJson, { secret: "whsec_other" }), 401, "invalid_signature");
    }));

  test("stale signature + non-JSON body answers 401 stale_signature, never 400", () =>
    withWorld(async (world) => {
      // Bug caught: parsing before the freshness check.
      const client = world.open();
      expectError(await client.send(notJson, { signedAt: String(SIGNED_AT_SECONDS - 1000) }), 401, "stale_signature");
    }));

  test("wrong signature + body with an unsupported currency answers 401, never 422", () =>
    withWorld(async (world) => {
      // Bug caught: validating the body (422) before the signature.
      const client = world.open();
      expectError(await client.send(authorized("evt_x", "pay_x", 100, "XXX"), { secret: "whsec_other" }), 401, "invalid_signature");
    }));

  test("wrong signature on a repeat of a recorded event answers 401, never duplicate or 409", () =>
    withWorld(async (world) => {
      // Bug caught: idempotency lookup before the signature check (id enumeration by unsigned callers).
      const client = world.open();
      expectDeferred(await client.send(captured("evt_rep", "pay_rep")));
      expectError(await client.send(captured("evt_rep", "pay_rep"), { secret: "whsec_other" }), 401, "invalid_signature");
      expectError(await client.send(captured("evt_rep", "pay_other"), { secret: "whsec_other" }), 401, "invalid_signature");
    }));

  test("signature errors are decided before the app touches the ledger (no hook call)", () =>
    withWorld(async (world) => {
      // Bug caught: calling beforeCommit (or writing) for a request answered 401.
      const calls: string[] = [];
      const client = world.open({ hooks: { beforeCommit: (eventId) => void calls.push(eventId) } });
      expectError(await client.send(authorized("evt_h", "pay_h", 100, "USD"), { secret: "whsec_other" }), 401, "invalid_signature");
      expectError(await client.send(authorized("evt_h", "pay_h", 100, "USD"), { signedAt: "1" }), 401, "stale_signature");
      expect(calls).toEqual([]);
      expectProcessed(await client.send(authorized("evt_h", "pay_h", 100, "USD")));
      expect(calls).toEqual(["evt_h"]);
    }));
});

