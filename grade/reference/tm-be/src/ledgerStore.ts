import type { Database } from 'bun:sqlite';
import { isSupportedCurrency, type Currency } from './types.ts';

/** Adds `deltaMinor` (negative for refunds) to a merchant's balance, creating the entry at 0 first. */
export function adjustBalance(db: Database, merchantId: string, currency: Currency, deltaMinor: number): void {
  db.query(
    `INSERT INTO ledger_entries (merchant_id, currency, balance_minor) VALUES (?, ?, ?)
     ON CONFLICT (merchant_id, currency) DO UPDATE SET balance_minor = balance_minor + excluded.balance_minor`,
  ).run(merchantId, currency, deltaMinor);
}

export type Balances = Partial<Record<Currency, number>>;

/** One entry per currency in which the merchant has a ledger entry; empty when it has none. */
export function readBalances(db: Database, merchantId: string): Balances {
  const rows = db
    .query<{ currency: string; balance_minor: number }, [string]>('SELECT currency, balance_minor FROM ledger_entries WHERE merchant_id = ?')
    .all(merchantId);
  const balances: Balances = {};
  for (const row of rows) {
    if (!isSupportedCurrency(row.currency)) throw new Error(`ledger holds unsupported currency ${row.currency}`);
    balances[row.currency] = row.balance_minor;
  }
  return balances;
}
