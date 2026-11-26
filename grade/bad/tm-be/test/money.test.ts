// Tier: High (money). Unit tests of the pure fee and split arithmetic.
import { describe, expect, test } from 'bun:test';
import { computeCaptureAmounts, splitLargestRemainder } from '../src/money.ts';
import type { FeeConfig } from '../src/types.ts';

const feesOf = (percentBps: number, usdFixed = 0): FeeConfig => ({ percentBps, fixedMinor: { USD: usdFixed, EUR: 0, JPY: 0, BHD: 0 } });

describe('computeCaptureAmounts', () => {
  // Bug caught: half-up or floor rounding of the percentage fee, a Number product losing precision, an uncapped fee. Tier: High.
  const cases: [string, number, FeeConfig, number][] = [
    ['tie 2.5 goes down to even 2', 25, feesOf(1000), 2],
    ['tie 3.5 goes up to even 4', 35, feesOf(1000), 4],
    ['tie 0.5 goes to 0', 5, feesOf(1000), 0],
    ['tie 1.5 goes to 2', 15, feesOf(1000), 2],
    ['13.1 rounds down to 13', 131, feesOf(1000), 13],
    ['just above a tie rounds up', 26, feesOf(1900), 5],
    ['fixed fee is added to the percentage fee', 131, feesOf(1000, 17), 30],
    ['fee is capped at the amount', 20, feesOf(1000, 30), 20],
    ['10000 bps takes the whole amount', 123, feesOf(10000), 123],
    ['product beyond 2^53 stays exact', 9007199254740991, feesOf(5000), 4503599627370496],
    ['maximum amount at 10000 bps', 9007199254740991, feesOf(10000), 9007199254740991],
  ];
  for (const [name, amountMinor, fees, expectedFee] of cases) {
    test(name, () => {
      const { feeMinor, netMinor } = computeCaptureAmounts(amountMinor, 'USD', fees);
      expect(feeMinor).toBe(expectedFee);
      expect(netMinor).toBe(amountMinor - expectedFee);
    });
  }
});

describe('splitLargestRemainder', () => {
  // Bug caught: wrong tie order, shares that do not sum to the total, floating-point floors on large totals. Tier: High.
  const cases: [string, number, number[], number[]][] = [
    ['worked example: ties go to the earlier split', 101, [3333, 3333, 3334], [34, 33, 34]],
    ['refund example', 50, [3333, 3333, 3334], [17, 16, 17]],
    ['zero total gives zero shares', 0, [3333, 3333, 3334], [0, 0, 0]],
    ['a zero weight gets nothing', 7, [0, 10000], [0, 7]],
    ['one split takes everything', 9007199254740991, [10000], [9007199254740991]],
    ['large total over thirds stays exact', 9007199254740991, [3333, 3333, 3334], [3002099511605172, 3002099511605172, 3003000231530647]],
  ];
  for (const [name, total, weights, expectedShares] of cases) {
    test(name, () => {
      const shares = splitLargestRemainder(total, weights);
      expect(shares).toEqual(expectedShares);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(total);
    });
  }
});
