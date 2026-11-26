import type { Database } from 'bun:sqlite';

export type RecordedEvent = { sequence: number; eventId: string; canonicalBody: string };

export type RecordResult = { recorded: true; sequence: number } | { recorded: false; existingCanonicalBody: string };

/**
 * The idempotency guard. The UNIQUE constraint on events.id decides who records an event id:
 * the conditional insert changes a row for exactly one caller, whatever the interleaving.
 */
export function recordEvent(db: Database, eventId: string, canonicalBody: string): RecordResult {
  const inserted = db
    .query<{ seq: number }, [string, string]>('INSERT INTO events (id, body) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING seq')
    .get(eventId, canonicalBody);
  if (inserted) return { recorded: true, sequence: inserted.seq };
  const existing = db.query<{ body: string }, [string]>('SELECT body FROM events WHERE id = ?').get(eventId);
  if (!existing) throw new Error(`event ${eventId} neither inserted nor found`);
  return { recorded: false, existingCanonicalBody: existing.body };
}

export function deferEvent(db: Database, sequence: number, paymentId: string): void {
  db.query('INSERT INTO deferred_events (event_seq, payment_id) VALUES (?, ?)').run(sequence, paymentId);
}

export function removeDeferredEvent(db: Database, sequence: number): void {
  db.query('DELETE FROM deferred_events WHERE event_seq = ?').run(sequence);
}

/** The deferred events of one payment in the order they were first accepted. */
export function listDeferredEvents(db: Database, paymentId: string): RecordedEvent[] {
  return db
    .query<{ seq: number; id: string; body: string }, [string]>(
      `SELECT events.seq, events.id, events.body
         FROM deferred_events JOIN events ON events.seq = deferred_events.event_seq
        WHERE deferred_events.payment_id = ?
        ORDER BY events.seq`,
    )
    .all(paymentId)
    .map((row) => ({ sequence: row.seq, eventId: row.id, canonicalBody: row.body }));
}
