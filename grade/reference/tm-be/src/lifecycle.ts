import type { Database } from 'bun:sqlite';
import { apiFailure, type ApiFailure } from './apiError.ts';
import { adjustBalance } from './ledgerStore.ts';
import { computeCaptureAmounts, splitLargestRemainder } from './money.ts';
import { addRefund, findPayment, insertPayment, markCaptured, markFailed, type PaymentRecord } from './paymentStore.ts';
import { fail, succeed, type Result } from './result.ts';
import type { FeeConfig } from './types.ts';
import type { WebhookEvent } from './webhookEvent.ts';

export type AppliedEvent = 'processed' | 'ignored' | 'deferred';

type Applied = Result<AppliedEvent, ApiFailure>;

function creditSplits(db: Database, payment: PaymentRecord, totalMinor: number, direction: 1 | -1): void {
  const shares = splitLargestRemainder(totalMinor, payment.splits.map((split) => split.weightBps));
  shares.forEach((share, position) => {
    const split = payment.splits[position];
    if (split === undefined) throw new Error(`split ${position} of payment ${payment.paymentId} is missing`);
    adjustBalance(db, split.merchantId, payment.currency, direction * share);
  });
}

/** Capture and failure share one rule: no payment defers, any state but authorized is ignored. */
function whenAuthorized(payment: PaymentRecord | null, change: (authorized: PaymentRecord) => void): Applied {
  if (payment === null) return succeed('deferred');
  if (payment.status !== 'authorized') return succeed('ignored');
  change(payment);
  return succeed('processed');
}

function applyRefund(db: Database, payment: PaymentRecord | null, amountMinor: number): Applied {
  if (payment === null || payment.status === 'authorized') return succeed('deferred');
  if (payment.status === 'failed') return succeed('ignored');
  if (amountMinor > payment.amountMinor - payment.refundedMinor) {
    return fail(apiFailure('refund_exceeds_capture', 'Refund amount exceeds the refundable amount of the payment'));
  }
  addRefund(db, payment.paymentId, amountMinor);
  creditSplits(db, payment, amountMinor, -1);
  return succeed('processed');
}

/**
 * Runs one event against the current state of its payment and writes its effects: the lifecycle
 * table of the spec. Fails with refund_exceeds_capture only for a refund that is applied and
 * too large; the caller decides whether that rolls the request back or discards a released event.
 */
export function applyEvent(db: Database, event: WebhookEvent, fees: FeeConfig): Applied {
  const payment = findPayment(db, event.paymentId);
  switch (event.kind) {
    case 'authorized':
      if (payment !== null) return succeed('ignored');
      insertPayment(db, event);
      return succeed('processed');
    case 'captured':
      return whenAuthorized(payment, (authorized) => {
        const { feeMinor, netMinor } = computeCaptureAmounts(authorized.amountMinor, authorized.currency, fees);
        markCaptured(db, authorized.paymentId, feeMinor);
        creditSplits(db, authorized, netMinor, 1);
      });
    case 'failed':
      return whenAuthorized(payment, (authorized) => markFailed(db, authorized.paymentId));
    case 'refunded':
      return applyRefund(db, payment, event.amountMinor);
  }
}
