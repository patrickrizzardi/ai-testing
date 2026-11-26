import { isJsonObject, isWholeNumberInRange } from './json.ts';
import { fail, succeed, type Result } from './result.ts';
import { SUPPORTED_CURRENCIES, type Currency, type FeeConfig } from './types.ts';

const MAX_PERCENT_BPS = 10000;

/** Checks the invariants of FeeConfig on untrusted input; the failure text names the offending field. */
export function validateFeeConfig(candidate: unknown): Result<FeeConfig, string> {
  if (!isJsonObject(candidate)) return fail('fees must be an object');
  const percentBps = candidate.percentBps;
  if (!isWholeNumberInRange(percentBps, 0, MAX_PERCENT_BPS)) {
    return fail(`fees.percentBps must be an integer from 0 to ${MAX_PERCENT_BPS}`);
  }
  const fixedMinor = candidate.fixedMinor;
  if (!isJsonObject(fixedMinor)) return fail('fees.fixedMinor must be an object');
  const checkedFixedMinor: Record<Currency, number> = { USD: 0, EUR: 0, JPY: 0, BHD: 0 };
  for (const currency of SUPPORTED_CURRENCIES) {
    const fixed = fixedMinor[currency];
    if (!isWholeNumberInRange(fixed, 0, Number.MAX_SAFE_INTEGER)) {
      return fail(`fees.fixedMinor.${currency} must be an integer >= 0`);
    }
    checkedFixedMinor[currency] = fixed;
  }
  return succeed({ percentBps, fixedMinor: checkedFixedMinor });
}
