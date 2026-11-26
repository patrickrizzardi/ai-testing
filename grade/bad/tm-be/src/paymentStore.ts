import type { Database } from 'bun:sqlite';
import { isSupportedCurrency, type Currency } from './types.ts';
import type { Split } from './webhookEvent.ts';

export type PaymentStatus = 'authorized' | 'captured' | 'failed';

export type PaymentRecord = {
  paymentId: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: Currency;
  feeMinor: number | null;
  refundedMinor: number;
  splits: Split[];
};

type PaymentRow = {
  payment_id: string;
  status: PaymentStatus;
  amount_minor: number;
  currency: string;
  fee_minor: number | null;
  refunded_minor: number;
};

export function insertPayment(db: Database, payment: { paymentId: string; amountMinor: number; currency: Currency; splits: Split[] }): void {
  db.query("INSERT INTO payments (payment_id, status, amount_minor, currency) VALUES (?, 'authorized', ?, ?)").run(
    payment.paymentId,
    payment.amountMinor,
    payment.currency,
  );
  const insertSplit = db.query('INSERT INTO payment_splits (payment_id, position, merchant_id, weight_bps) VALUES (?, ?, ?, ?)');
  payment.splits.forEach((split, position) => insertSplit.run(payment.paymentId, position, split.merchantId, split.weightBps));
}

export function findPayment(db: Database, paymentId: string): PaymentRecord | null {
  const row = db
    .query<PaymentRow, [string]>('SELECT payment_id, status, amount_minor, currency, fee_minor, refunded_minor FROM payments WHERE payment_id = ?')
    .get(paymentId);
  if (!row) return null;
  if (!isSupportedCurrency(row.currency)) throw new Error(`payment ${paymentId} holds unsupported currency ${row.currency}`);
  const splits = db
    .query<{ merchant_id: string; weight_bps: number }, [string]>('SELECT merchant_id, weight_bps FROM payment_splits WHERE payment_id = ? ORDER BY position')
    .all(paymentId)
    .map((splitRow) => ({ merchantId: splitRow.merchant_id, weightBps: splitRow.weight_bps }));
  return {
    paymentId: row.payment_id,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    feeMinor: row.fee_minor,
    refundedMinor: row.refunded_minor,
    splits,
  };
}

export function markCaptured(db: Database, paymentId: string, feeMinor: number): void {
  db.query("UPDATE payments SET status = 'captured', fee_minor = ? WHERE payment_id = ?").run(feeMinor, paymentId);
}

export function markFailed(db: Database, paymentId: string): void {
  db.query("UPDATE payments SET status = 'failed' WHERE payment_id = ?").run(paymentId);
}

export function addRefund(db: Database, paymentId: string, amountMinor: number): void {
  db.query('UPDATE payments SET refunded_minor = refunded_minor + ? WHERE payment_id = ?').run(amountMinor, paymentId);
}
