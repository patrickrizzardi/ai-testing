import { createLocalDateReader, daysInMonth } from './calendar.ts';
import type { Budget, BudgetSummary, SpendInstant } from './domain.ts';

type SummaryInput = {
  budget: Budget;
  spends: readonly SpendInstant[];
  timeZone: string;
  nowEpochMs: number;
};

function formatMonth(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * The budget's state for the calendar month, in `timeZone`, that contains `nowEpochMs`.
 * O(s) time for s spends (one local-date read each), O(1) extra memory.
 */
export function summarizeBudget({ budget, spends, timeZone, nowEpochMs }: SummaryInput): BudgetSummary {
  const readLocalDate = createLocalDateReader(timeZone);
  const today = readLocalDate(nowEpochMs);
  const spentCents = spends
    .filter((spend) => {
      const spendDate = readLocalDate(spend.spentAtEpochMs);
      return spendDate.year === today.year && spendDate.month === today.month;
    })
    .reduce((total, spend) => total + spend.amountCents, 0);
  const remainingCents = budget.limitCents - spentCents;
  const daysLeft = daysInMonth(today.year, today.month) - today.day + 1;
  return {
    category: budget.category,
    month: formatMonth(today.year, today.month),
    limitCents: budget.limitCents,
    spentCents,
    remainingCents,
    daysLeft,
    dailyAllowanceCents: remainingCents > 0 ? Math.floor(remainingCents / daysLeft) : 0,
  };
}
