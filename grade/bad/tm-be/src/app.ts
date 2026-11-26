import { apiFailure } from './apiError.ts';
import { openDatabase } from './database.ts';
import { validateFeeConfig } from './feeConfig.ts';
import { handleBalanceRead, handlePaymentRead } from './readHandlers.ts';
import { createReceiver } from './receiver.ts';
import { errorResponse } from './responses.ts';
import { matchRoute } from './router.ts';
import { handleWebhook } from './webhookHandler.ts';

import type { App, AppOptions } from './types.ts';

export type { App, AppOptions, Currency, FeeConfig } from './types.ts';

export function createApp(options: AppOptions): App {
  const fees = validateFeeConfig(options.fees);
  if (!fees.ok) throw new Error(fees.error);
  const now = options.now ?? (() => new Date());
  const db = openDatabase(options.dbPath);
  const receiver = createReceiver({ db, fees: fees.value, beforeCommit: options.hooks?.beforeCommit });
  let closed = false;

  async function route(request: Request): Promise<Response> {
    const matched = matchRoute(request);
    if (!matched.ok) return errorResponse(matched.error);
    switch (matched.value.kind) {
      case 'webhook':
        return handleWebhook(request, { receiver, secret: options.secret, now });
      case 'balance':
        return handleBalanceRead(db, matched.value.merchantId);
      case 'payment':
        return handlePaymentRead(db, matched.value.paymentId);
    }
  }

  return {
    async fetch(request) {
      try {
        return await route(request);
      } catch (error) {
        console.error('tm-be: unexpected failure while handling a request', error);
        return errorResponse(apiFailure('internal_error', 'The server could not process the request'));
      }
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
