import type { Database } from 'bun:sqlite';
import { apiFailure } from './apiError.ts';
import { readBalances } from './ledgerStore.ts';
import { findPayment } from './paymentStore.ts';
import { errorResponse, jsonResponse } from './responses.ts';
import { succeed } from './result.ts';
import { catchThrown } from './thrownErrors.ts';

export function handleBalanceRead(db: Database, merchantId: string): Response {
  const read = catchThrown(() => succeed(readBalances(db, merchantId)));
  if (!read.ok) return errorResponse(read.error);
  const balances = read.value;
  if (Object.keys(balances).length === 0) {
    return errorResponse(apiFailure('not_found', `Merchant ${JSON.stringify(merchantId)} has no ledger entry`));
  }
  return jsonResponse(200, { merchantId, balances });
}

export function handlePaymentRead(db: Database, paymentId: string): Response {
  const read = catchThrown(() => succeed(findPayment(db, paymentId)));
  if (!read.ok) return errorResponse(read.error);
  const payment = read.value;
  if (payment === null) return errorResponse(apiFailure('not_found', `Payment ${JSON.stringify(paymentId)} does not exist`));
  return jsonResponse(200, {
    paymentId: payment.paymentId,
    status: payment.status,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    feeMinor: payment.feeMinor,
    refundedMinor: payment.refundedMinor,
  });
}
