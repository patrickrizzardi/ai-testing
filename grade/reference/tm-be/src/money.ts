import type { Currency, FeeConfig } from './types.ts';

const BPS_DENOMINATOR = 10000n;

/**
 * Exact rational arithmetic in BigInt: amount x bps reaches 9e19, beyond the 2^53 range where
 * floating point stays exact, so a Number product would round before the rounding rule applies.
 */
function roundHalfEvenQuotient(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const doubledRemainder = (numerator % denominator) * 2n;
  if (doubledRemainder > denominator) return quotient + 1n;
  if (doubledRemainder === denominator && quotient % 2n === 1n) return quotient + 1n;
  return quotient;
}

export type CaptureAmounts = { feeMinor: number; netMinor: number };

/** O(1) time and memory. fee = min(roundHalfEven(amount x percentBps / 10000) + fixed, amount). */
export function computeCaptureAmounts(amountMinor: number, currency: Currency, fees: FeeConfig): CaptureAmounts {
  const percentFee = roundHalfEvenQuotient(BigInt(amountMinor) * BigInt(fees.percentBps), BPS_DENOMINATOR);
  const uncappedFee = percentFee + BigInt(fees.fixedMinor[currency]);
  const feeMinor = uncappedFee < BigInt(amountMinor) ? uncappedFee : BigInt(amountMinor);
  return { feeMinor: Number(feeMinor), netMinor: amountMinor - Number(feeMinor) };
}

/**
 * Largest-remainder split of totalMinor over weights (basis points summing to 10000).
 * O(n log n) time, O(n) memory for n weights: sorts the remainders.
 * Returns one share per weight, in weight order; shares are >= 0 and sum to totalMinor.
 */
export function splitLargestRemainder(totalMinor: number, weightsBps: readonly number[]): number[] {
  const total = BigInt(totalMinor);
  const weighted = weightsBps.map((weightBps) => total * BigInt(weightBps));
  const shares = weighted.map((product) => product / BPS_DENOMINATOR);
  const leftover = Number(total - shares.reduce((sum, share) => sum + share, 0n));
  const positionsByRemainder = weighted
    .map((product, position) => ({ position, remainder: product % BPS_DENOMINATOR }))
    .sort((left, right) => {
      if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
      return left.position - right.position;
    });
  for (const { position } of positionsByRemainder.slice(0, leftover)) {
    shares[position] = (shares[position] ?? 0n) + 1n;
  }
  return shares.map(Number);
}
