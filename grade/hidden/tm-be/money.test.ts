// Spec: "Money", "Capture and fee", "Largest-remainder split" and "Refund" (High tier: pure math on money).
import { describe, expect, test } from "bun:test";
import {
  MAX_SAFE,
  THIRDS,
  authorized,
  captured,
  expectBalances,
  expectError,
  expectPayment,
  expectProcessed,
  feesOf,
  refunded,
  snapshot,
  split,
  withWorld,
  type Client,
  type Currency,
  type SplitInput,
} from "./support.ts";

const merchantsOf = (weights: number[]): SplitInput[] => weights.map((weight, index) => split(`m_${index}`, weight));

/** Authorizes and captures one payment; the merchants are m_0..m_n in list order. */
async function capture(
  client: Client,
  amountMinor: number,
  weights: number[],
  currency: Currency = "USD",
  paymentId = "pay_1",
): Promise<void> {
  expectProcessed(await client.send(authorized(`a_${paymentId}`, paymentId, amountMinor, currency, merchantsOf(weights))));
  expectProcessed(await client.send(captured(`c_${paymentId}`, paymentId)));
}

describe("money: fee = min(roundHalfEven(A x bps / 10000) + fixed, A)", () => {
  // [bps, fixed USD, A, expected fee]
  const fees: [number, number, number, number][] = [
    // Spec examples, bps 1000: ties go to the even integer both ways.
    [1000, 0, 25, 2],
    [1000, 0, 35, 4],
    [1000, 0, 5, 0],
    [1000, 0, 15, 2],
    [1000, 0, 131, 13],
    // More ties and non-ties around them.
    [1000, 0, 45, 4],
    [1000, 0, 55, 6],
    [1000, 0, 1, 0],
    [1000, 0, 6, 1],
    [1000, 0, 4, 0],
    [1000, 0, 10000, 1000],
    // Ties at other basis-point values.
    [1, 0, 5000, 0],
    [1, 0, 15000, 2],
    [1, 0, 25000, 2],
    [5000, 0, 1, 0],
    [5000, 0, 3, 2],
    [5000, 0, 5, 2],
    [5000, 0, 7, 4],
    [5000, 0, 9, 4],
    // Rounding is applied to the percentage part only; the fixed fee is added afterwards.
    [1000, 1, 25, 3],
    [1000, 1, 35, 5],
    [1000, 17, 100, 27],
    [1000, 17, 131, 30],
    // Zero and cap.
    [0, 0, 100, 0],
    [0, 5, 100, 5],
    [10000, 0, 100, 100],
    [10000, 5, 100, 100],
    [0, 100, 100, 100],
    [0, 101, 100, 100],
    [1000, 30, 20, 20],
    [290, 30, 10000, 320],
    // Beyond 2^53 intermediate products: A x bps overflows double precision.
    [9999, 0, MAX_SAFE, 9006298534815517],
    [5000, 0, MAX_SAFE, 4503599627370496],
    [290, 30, MAX_SAFE, 261208778387519],
    // Non-tie values near 2^53 where a double-precision A x bps / 10000 lands on the wrong integer.
    [5000, 0, 8912476626103438, 4456238313051719],
    [9999, 0, 8820005115888487, 8819123115376898],
    [1250, 0, 8359083261893107, 1044885407736638],
  ];
  for (const [bps, fixedUsd, amount, expectedFee] of fees) {
    test(`bps ${bps}, fixed ${fixedUsd}, amount ${amount} → fee ${expectedFee}`, () =>
      withWorld(async (world) => {
        // Bug caught: wrong rounding mode (half-up, banker's on the wrong operand), rounding after adding fixed, missing cap, float overflow.
        const client = world.open({ fees: feesOf(bps, { USD: fixedUsd }) });
        await capture(client, amount, [10000]);
        await expectPayment(client, "pay_1", { status: "captured", amountMinor: amount, currency: "USD", feeMinor: expectedFee, refundedMinor: 0 });
        await expectBalances(client, "m_0", { USD: amount - expectedFee });
      }));
  }
});

describe("money: fixed fee and exponent per currency", () => {
  const perCurrency: [Currency, number, number, number][] = [
    // [currency, amount, expected fee, expected net], fees: 290 bps, fixed USD 30 / EUR 25 / JPY 0 / BHD 300
    ["USD", 10000, 320, 9680],
    ["EUR", 10000, 315, 9685],
    ["JPY", 10000, 290, 9710],
    ["BHD", 10000, 590, 9410],
    ["JPY", 1000, 29, 971],
    ["BHD", 12345, 658, 11687],
    ["USD", 12345, 388, 11957],
    ["EUR", 1, 1, 0],
  ];
  for (const [currency, amount, fee, net] of perCurrency) {
    test(`${currency} amount ${amount} → fee ${fee}, net ${net}`, () =>
      withWorld(async (world) => {
        // Bug caught: using one fixed fee for every currency, scaling by the exponent, or crediting another currency's key.
        const client = world.open({ fees: feesOf(290, { USD: 30, EUR: 25, JPY: 0, BHD: 300 }) });
        await capture(client, amount, [10000], currency);
        await expectPayment(client, "pay_1", { status: "captured", amountMinor: amount, currency, feeMinor: fee, refundedMinor: 0 });
        await expectBalances(client, "m_0", { [currency]: net });
      }));
  }

  test("a merchant paid in several currencies and by several payments keeps one balance per currency", () =>
    withWorld(async (world) => {
      // Bug caught: one balance per merchant regardless of currency, or overwriting instead of accumulating.
      const client = world.open();
      await capture(client, 100, [10000], "USD", "p1");
      await capture(client, 250, [10000], "USD", "p2");
      await capture(client, 7, [10000], "EUR", "p3");
      await capture(client, 1500, [10000], "JPY", "p4");
      await capture(client, 1234, [10000], "BHD", "p5");
      await expectBalances(client, "m_0", { USD: 350, EUR: 7, JPY: 1500, BHD: 1234 });
    }));
});

describe("money: fee reaching the cap", () => {
  test("fee capped at the amount: net 0, every share 0, and every merchant still gets a ledger entry of 0", () =>
    withWorld(async (world) => {
      // Bug caught: negative net, skipping merchants whose share is 0, or no cap.
      const client = world.open({ fees: feesOf(1000, { USD: 30 }) });
      await capture(client, 20, [3333, 3333, 3334]);
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 20, currency: "USD", feeMinor: 20, refundedMinor: 0 });
      for (const merchantId of ["m_0", "m_1", "m_2"]) await expectBalances(client, merchantId, { USD: 0 });
    }));

  test("a zero-weight merchant and a zero share still get a ledger entry at capture", () =>
    withWorld(async (world) => {
      // Bug caught: creating ledger rows only for non-zero shares.
      const client = world.open();
      await capture(client, 100, [0, 10000]);
      await expectBalances(client, "m_0", { USD: 0 });
      await expectBalances(client, "m_1", { USD: 100 });
    }));
});

describe("money: largest-remainder split of the net", () => {
  // [net, weights, expected shares]; the fee is 0 so the net equals the amount.
  const splits: [number, number[], number[]][] = [
    [101, [3333, 3333, 3334], [34, 33, 34]], // the spec's worked example
    [50, [3333, 3333, 3334], [17, 16, 17]],
    [100, [3333, 3333, 3334], [33, 33, 34]],
    [131, [3333, 3333, 3334], [44, 43, 44]],
    [10, [3333, 3333, 3334], [3, 3, 4]],
    [1, [3333, 3333, 3334], [0, 0, 1]],
    [2, [3333, 3333, 3334], [1, 0, 1]],
    [1, [5000, 5000], [1, 0]], // exact remainder tie: the earlier split wins
    [2, [5000, 5000], [1, 1]],
    [1, [2500, 2500, 2500, 2500], [1, 0, 0, 0]],
    [3, [2500, 2500, 2500, 2500], [1, 1, 1, 0]],
    [7, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], [1, 1, 1, 1, 1, 1, 1, 0, 0, 0]],
    [3, [3334, 3333, 3333], [1, 1, 1]],
    [7, [0, 5000, 0, 5000], [0, 4, 0, 3]],
    [9, [5000, 3000, 2000], [4, 3, 2]],
    [3, [1, 9999], [0, 3]],
    [999, [1, 9, 990, 9000], [0, 1, 99, 899]],
    [100, [0, 10000], [0, 100]],
    [100, [10000], [100]],
    [1000, [2500, 2500, 2500, 2500], [250, 250, 250, 250]],
    [5, [2000, 2000, 2000, 2000, 2000], [1, 1, 1, 1, 1]],
    // Products above 2^53: T x weight is not exact in double precision.
    [MAX_SAFE, [3333, 3333, 3334], [3002099511605172, 3002099511605172, 3003000231530647]],
    [MAX_SAFE - 1, [1, 9, 990, 9000], [900719925474, 8106479329267, 891712726219358, 8106479329266891]],
    [9007063388933395, [3333, 3333, 3334], [3002054227531501, 3002054227531500, 3002954933870394]],
    [9006280530322877, [1000, 2000, 3000, 4000], [900628053032288, 1801256106064575, 2701884159096863, 3602512212129151]],
  ];
  for (const [net, weights, shares] of splits) {
    test(`net ${net} over [${weights.join(",")}] → [${shares.join(",")}]`, () =>
      withWorld(async (world) => {
        // Bug caught: plain rounding or floor-only splits that do not sum to net; wrong tie order; float error on huge values.
        const client = world.open();
        await capture(client, net, weights);
        for (const [index, share] of shares.entries()) await expectBalances(client, `m_${index}`, { USD: share });
      }));
  }

  test("the spec's worked example: fee, shares and a partial refund", () =>
    withWorld(async (world) => {
      // Bug caught: any deviation from the spec's own numbers (fee 30, shares 34/33/34, refund shares 17/16/17, fee not returned).
      const client = world.open({ fees: feesOf(1000, { USD: 17 }) });
      await capture(client, 131, [3333, 3333, 3334]);
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 131, currency: "USD", feeMinor: 30, refundedMinor: 0 });
      await expectBalances(client, "m_0", { USD: 34 });
      await expectBalances(client, "m_1", { USD: 33 });
      await expectBalances(client, "m_2", { USD: 34 });
      expectProcessed(await client.send(refunded("e_ref", "pay_1", 50)));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 131, currency: "USD", feeMinor: 30, refundedMinor: 50 });
      await expectBalances(client, "m_0", { USD: 17 });
      await expectBalances(client, "m_1", { USD: 17 });
      await expectBalances(client, "m_2", { USD: 17 });
    }));
});

describe("money: refunds", () => {
  test("each refund is split on its own amount and shares are not corrected against earlier refunds (balances may go negative)", () =>
    withWorld(async (world) => {
      // Bug caught: splitting the cumulative refund, or giving the tie to the other merchant to "balance" earlier shares.
      const client = world.open();
      await capture(client, 2, [5000, 5000]);
      expectProcessed(await client.send(refunded("r1", "pay_1", 1)));
      await expectBalances(client, "m_0", { USD: 0 });
      await expectBalances(client, "m_1", { USD: 1 });
      expectProcessed(await client.send(refunded("r2", "pay_1", 1)));
      await expectBalances(client, "m_0", { USD: -1 });
      await expectBalances(client, "m_1", { USD: 1 });
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 2, currency: "USD", feeMinor: 0, refundedMinor: 2 });
    }));

  // [amount, weights, refund, expected balances after capture + refund]
  const refundSplits: [number, number[], number, number[]][] = [
    [131, [3333, 3333, 3334], 50, [27, 27, 27]], // 44,43,44 minus 17,16,17
    [131, [3333, 3333, 3334], 131, [0, 0, 0]],
    [100, [3333, 3333, 3334], 1, [33, 33, 33]],
    [100, [5000, 5000], 3, [48, 49]],
    [MAX_SAFE, [3333, 3333, 3334], MAX_SAFE, [0, 0, 0]],
  ];
  for (const [amount, weights, refund, balances] of refundSplits) {
    test(`capture ${amount} over [${weights.join(",")}] then refund ${refund} → [${balances.join(",")}]`, () =>
      withWorld(async (world) => {
        // Bug caught: refund shares computed with another rule than the capture split (rounding, tie order, overflow).
        const client = world.open();
        await capture(client, amount, weights);
        expectProcessed(await client.send(refunded("r1", "pay_1", refund)));
        for (const [index, balance] of balances.entries()) await expectBalances(client, `m_${index}`, { USD: balance });
      }));
  }

  test("a refund debits only the payment's currency", () =>
    withWorld(async (world) => {
      // Bug caught: debiting every balance of the merchant or the wrong currency key.
      const client = world.open();
      await capture(client, 100, [10000], "USD", "p_usd");
      await capture(client, 100, [10000], "JPY", "p_jpy");
      expectProcessed(await client.send(refunded("r1", "p_jpy", 40)));
      await expectBalances(client, "m_0", { USD: 100, JPY: 60 });
    }));

  test("partial refunds summing exactly to the capture are all accepted; one more unit is 422", () =>
    withWorld(async (world) => {
      // Bug caught: off-by-one on the refundable amount (>= instead of >) or comparing against the amount instead of A - R.
      const client = world.open();
      await capture(client, 100, [3333, 3333, 3334]);
      expectProcessed(await client.send(refunded("r1", "pay_1", 30)));
      expectProcessed(await client.send(refunded("r2", "pay_1", 30)));
      expectProcessed(await client.send(refunded("r3", "pay_1", 40)));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 100 });
      // Per-refund shares: 30 → [10,10,10] twice, 40 → [13,13,14]; capture [33,33,34].
      await expectBalances(client, "m_0", { USD: 0 });
      await expectBalances(client, "m_1", { USD: 0 });
      await expectBalances(client, "m_2", { USD: 0 });
      expectError(await client.send(refunded("r4", "pay_1", 1)), 422, "refund_exceeds_capture");
    }));

  test("over-refund answers 422 refund_exceeds_capture and records nothing, at the boundary A - R + 1", () =>
    withWorld(async (world) => {
      // Bug caught: partially applying or recording a refund that is then rejected; an off-by-one boundary.
      const client = world.open();
      await capture(client, 100, [5000, 5000]);
      expectError(await client.send(refunded("r0", "pay_1", 101)), 422, "refund_exceeds_capture");
      expectProcessed(await client.send(refunded("r1", "pay_1", 60)));
      const before = await snapshot(client, ["pay_1"], ["m_0", "m_1"]);
      expectError(await client.send(refunded("r2", "pay_1", 41)), 422, "refund_exceeds_capture");
      expect(await snapshot(client, ["pay_1"], ["m_0", "m_1"])).toEqual(before);
      expectProcessed(await client.send(refunded("r3", "pay_1", 40)));
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 0, refundedMinor: 100 });
    }));

  test("the refund limit is the captured amount, not the net after fee", () =>
    withWorld(async (world) => {
      // Bug caught: comparing refunds with net instead of the payment amount A.
      const client = world.open({ fees: feesOf(1000, { USD: 30 }) });
      await capture(client, 100, [10000]);
      await expectBalances(client, "m_0", { USD: 60 });
      expectProcessed(await client.send(refunded("r1", "pay_1", 100)));
      await expectBalances(client, "m_0", { USD: -40 });
      await expectPayment(client, "pay_1", { status: "captured", amountMinor: 100, currency: "USD", feeMinor: 40, refundedMinor: 100 });
    }));

  test("refunds near the safe-integer limit: MAX - 1 then 2 is 422, then 1 is accepted", () =>
    withWorld(async (world) => {
      // Bug caught: float error in R + amount or A - R at the top of the safe-integer range.
      const client = world.open();
      await capture(client, MAX_SAFE, [10000]);
      expectProcessed(await client.send(refunded("r1", "pay_1", MAX_SAFE - 1)));
      expectError(await client.send(refunded("r2", "pay_1", 2)), 422, "refund_exceeds_capture");
      expectProcessed(await client.send(refunded("r3", "pay_1", 1)));
      await expectBalances(client, "m_0", { USD: 0 });
    }));
});
