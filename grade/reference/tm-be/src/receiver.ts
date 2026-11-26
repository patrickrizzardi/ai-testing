import type { Database } from 'bun:sqlite';
import { apiFailure, type ApiFailure } from './apiError.ts';
import { runInTransaction } from './database.ts';
import { deferEvent, recordEvent } from './eventStore.ts';
import { applyEvent } from './lifecycle.ts';
import { releaseDeferredEvents } from './release.ts';
import { fail, succeed, type Result } from './result.ts';
import type { ReceiveOutcome } from './responses.ts';
import { catchThrown } from './thrownErrors.ts';
import type { FeeConfig } from './types.ts';
import type { WebhookEvent } from './webhookEvent.ts';

export type Receiver = {
  receive(event: WebhookEvent, canonicalBody: string): Result<ReceiveOutcome, ApiFailure>;
};

export type ReceiverDependencies = {
  db: Database;
  fees: FeeConfig;
  beforeCommit?: (eventId: string) => void;
};

/**
 * One request is one transaction: the recorded event id, the payment, the ledger and every
 * released deferred event commit together or not at all. The event id is recorded first, by the
 * database's unique key, so concurrent requests with one id cannot both take effect.
 */
export function createReceiver(dependencies: ReceiverDependencies): Receiver {
  const { db, fees, beforeCommit } = dependencies;

  function receiveInsideTransaction(event: WebhookEvent, canonicalBody: string): Result<ReceiveOutcome, ApiFailure> {
    const recording = recordEvent(db, event.eventId, canonicalBody);
    if (!recording.recorded) {
      return recording.existingCanonicalBody === canonicalBody
        ? succeed('duplicate')
        : fail(apiFailure('event_conflict', `Event ${event.eventId} was already received with a different body`));
    }

    const applied = applyEvent(db, event, fees);
    if (!applied.ok) return applied;
    if (applied.value === 'deferred') deferEvent(db, recording.sequence, event.paymentId);
    if (applied.value === 'processed') {
      const released = releaseDeferredEvents(db, event.paymentId, fees);
      if (!released.ok) return released;
    }
    beforeCommit?.(event.eventId);
    return succeed(applied.value);
  }

  return { receive: (event, canonicalBody) => catchThrown(() => runInTransaction(db, () => receiveInsideTransaction(event, canonicalBody))) };
}
