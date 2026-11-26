// Spec: `createApp` options: fee validation, `close`, default clock.
import { describe, expect, test } from "bun:test";
import {
  SECRET,
  ZERO_FEES,
  authorized,
  captured,
  createApp,
  expectDeferred,
  expectError,
  feesOf,
  newWorld,
  signatureOf,
  toReply,
  webhookRequest,
  withWorld,
  type FeeConfig,
} from "./support.ts";

const validFixed = { USD: 30, EUR: 25, JPY: 0, BHD: 300 };

describe("createApp: fees must satisfy the invariants of FeeConfig", () => {
  const invalid: [string, unknown][] = [
    ["percentBps negative", { percentBps: -1, fixedMinor: validFixed }],
    ["percentBps above 10000", { percentBps: 10001, fixedMinor: validFixed }],
    ["percentBps fractional", { percentBps: 1.5, fixedMinor: validFixed }],
    ["percentBps NaN", { percentBps: Number.NaN, fixedMinor: validFixed }],
    ["percentBps a string", { percentBps: "290", fixedMinor: validFixed }],
    ["percentBps missing", { fixedMinor: validFixed }],
    ["fixedMinor missing", { percentBps: 290 }],
    ["fixedMinor lacks USD", { percentBps: 290, fixedMinor: { EUR: 25, JPY: 0, BHD: 300 } }],
    ["fixedMinor lacks EUR", { percentBps: 290, fixedMinor: { USD: 30, JPY: 0, BHD: 300 } }],
    ["fixedMinor lacks JPY", { percentBps: 290, fixedMinor: { USD: 30, EUR: 25, BHD: 300 } }],
    ["fixedMinor lacks BHD", { percentBps: 290, fixedMinor: { USD: 30, EUR: 25, JPY: 0 } }],
    ["fixedMinor negative", { percentBps: 290, fixedMinor: { ...validFixed, USD: -1 } }],
    ["fixedMinor fractional", { percentBps: 290, fixedMinor: { ...validFixed, EUR: 0.5 } }],
    ["fixedMinor a string", { percentBps: 290, fixedMinor: { ...validFixed, JPY: "0" } }],
    ["fixedMinor NaN", { percentBps: 290, fixedMinor: { ...validFixed, BHD: Number.NaN } }],
    ["fixedMinor Infinity", { percentBps: 290, fixedMinor: { ...validFixed, BHD: Number.POSITIVE_INFINITY } }],
  ];
  for (const [name, fees] of invalid) {
    test(`throws an Error: ${name}`, () => {
      // Bug caught: accepting a fee config the capture arithmetic cannot handle (NaN fees, negative net, missing currency).
      const world = newWorld();
      try {
        // Control: the same call with a valid config must work, so a stub that always throws cannot pass.
        createApp({ dbPath: world.dbPath, secret: SECRET, fees: feesOf(290, validFixed) }).close();
        expect(() => createApp({ dbPath: world.dbPath, secret: SECRET, fees: fees as FeeConfig })).toThrow(Error);
      } finally {
        world.cleanup();
      }
    });
  }

  test("boundary configs are accepted: 0 and 10000 bps, all-zero fixed fees", () => {
    // Bug caught: off-by-one in the percentBps range check.
    const world = newWorld();
    try {
      createApp({ dbPath: world.dbPath, secret: SECRET, fees: feesOf(0) }).close();
      createApp({ dbPath: world.dbPath, secret: SECRET, fees: feesOf(10000, validFixed) }).close();
    } finally {
      world.cleanup();
    }
  });
});

describe("createApp: close and clock", () => {
  test("close may be called more than once", () => {
    // Bug caught: a second close() throwing "database is closed".
    const world = newWorld();
    try {
      const app = createApp({ dbPath: world.dbPath, secret: SECRET, fees: ZERO_FEES });
      app.close();
      expect(() => app.close()).not.toThrow();
      expect(() => app.close()).not.toThrow();
    } finally {
      world.cleanup();
    }
  });

  test("closing one instance does not disturb another on the same file", () =>
    withWorld(async (world) => {
      // Bug caught: close() deleting the file or locking the database for the remaining instances.
      const first = world.open();
      const second = world.open();
      expectDeferred(await first.send(captured("e1", "pay_1")));
      first.app.close();
      expectDeferred(await second.send(captured("e2", "pay_2")));
      expect((await second.send(authorized("e3", "pay_3", 5, "USD"))).status).toBe(200);
    }));

  test("without `now` the real clock is used for the freshness check", async () => {
    // Bug caught: a hard-coded or missing default clock (everything stale, or nothing ever stale).
    const world = newWorld();
    const app = createApp({ dbPath: world.dbPath, secret: SECRET, fees: ZERO_FEES });
    try {
      const raw = JSON.stringify(captured("e1", "pay_1"));
      const realSeconds = Math.floor(Date.now() / 1000);
      const fresh = await toReply(await app.fetch(webhookRequest("http://localhost", raw, {}, String(realSeconds))));
      expectDeferred(fresh);
      const oldSignature = await toReply(
        await app.fetch(
          new Request("http://localhost/webhooks", {
            method: "POST",
            body: JSON.stringify(captured("e2", "pay_1")),
            headers: { "Webhook-Signature": `t=1700000000,v1=${signatureOf("1700000000", JSON.stringify(captured("e2", "pay_1")))}` },
          }),
        ),
      );
      expectError(oldSignature, 401, "stale_signature");
    } finally {
      app.close();
      world.cleanup();
    }
  });
});
