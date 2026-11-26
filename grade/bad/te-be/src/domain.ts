export type User = { id: number; name: string; timeZone: string };
export type Budget = { category: string; limitCents: number };
export type Spend = { id: number; category: string; amountCents: number; spentAt: string };

export type NewUser = { name: string; timeZone: string };
export type NewBudget = { category: string; limitCents: number };
export type NewSpend = {
  category: string;
  amountCents: number;
  /** The timestamp text exactly as the client sent it. */
  spentAt: string;
  /** The instant `spentAt` denotes, in epoch milliseconds (sub-millisecond digits are dropped). */
  spentAtEpochMs: number;
};

export type SpendInstant = { amountCents: number; spentAtEpochMs: number };

export type BudgetSummary = {
  category: string;
  month: string;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  daysLeft: number;
  dailyAllowanceCents: number;
};
