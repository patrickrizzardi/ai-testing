import type { Database } from 'bun:sqlite';
import { internalFailure, type ApiFailure } from './apiError.ts';
import { listDeferredEvents, removeDeferredEvent } from './eventStore.ts';
import { parseJsonObject } from './json.ts';
import { applyEvent } from './lifecycle.ts';
import { fail, succeed, type Result } from './result.ts';
import type { FeeConfig } from './types.ts';
import { validateEvent } from './webhookEvent.ts';

/**
 * Runs the deferred events of one payment, in the order they were accepted, until a full pass
 * applies nothing new. An applied event is released; one that would be ignored, or a refund
 * that is now too large, is discarded; one still waiting stays. Each pass rereads the payment
 * state through applyEvent, so an event applied early in a pass is seen by the ones after it.
 * O(p x d) time for d deferred events and p passes (p <= d + 1), O(d) memory.
 */
export function releaseDeferredEvents(db: Database, paymentId: string, fees: FeeConfig): Result<void, ApiFailure> {
  let appliedInPass = true;
  while (appliedInPass) {
    appliedInPass = false;
    for (const deferred of listDeferredEvents(db, paymentId)) {
      const body = parseJsonObject(deferred.canonicalBody);
      const event = body.ok ? validateEvent(body.value) : body;
      if (!event.ok) {
        console.error(`tm-be: stored deferred event ${deferred.eventId} is no longer valid`);
        return fail(internalFailure());
      }
      const applied = applyEvent(db, event.value, fees);
      const stillWaiting = applied.ok && applied.value === 'deferred';
      if (stillWaiting) continue;
      removeDeferredEvent(db, deferred.sequence);
      appliedInPass ||= applied.ok && applied.value === 'processed';
    }
  }
  return succeed(undefined);
}
