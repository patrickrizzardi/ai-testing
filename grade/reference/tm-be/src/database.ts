import { Database } from 'bun:sqlite';
import { succeed, type Result } from './result.ts';

/** A request waits this long for another connection's write lock instead of failing. */
const BUSY_TIMEOUT_MILLISECONDS = 120_000;

const WAL_RETRY_DELAY_MILLISECONDS = 5;

const SCHEMA_VERSION = 1;

// PRAGMA values cannot be bound; these two are built once from constants, never from input.
const SET_BUSY_TIMEOUT = `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`;
const SET_SCHEMA_VERSION = `PRAGMA user_version = ${SCHEMA_VERSION}`;

// Money is INTEGER minor units end to end. The CHECKs and keys are the last line of defence
// for the invariants the code also maintains: one event id, one payment id, refunds within capture.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     body TEXT NOT NULL
   )`,
  `CREATE TABLE payments (
     payment_id TEXT PRIMARY KEY,
     status TEXT NOT NULL CHECK (status IN ('authorized', 'captured', 'failed')),
     amount_minor INTEGER NOT NULL CHECK (amount_minor >= 1),
     currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'JPY', 'BHD')),
     fee_minor INTEGER CHECK (fee_minor >= 0 AND fee_minor <= amount_minor),
     refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
     CHECK ((status = 'captured') = (fee_minor IS NOT NULL))
   )`,
  `CREATE TABLE payment_splits (
     payment_id TEXT NOT NULL REFERENCES payments (payment_id),
     position INTEGER NOT NULL,
     merchant_id TEXT NOT NULL,
     weight_bps INTEGER NOT NULL CHECK (weight_bps >= 0 AND weight_bps <= 10000),
     PRIMARY KEY (payment_id, position)
   )`,
  `CREATE TABLE ledger_entries (
     merchant_id TEXT NOT NULL,
     currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'JPY', 'BHD')),
     balance_minor INTEGER NOT NULL,
     PRIMARY KEY (merchant_id, currency)
   )`,
  `CREATE TABLE deferred_events (
     event_seq INTEGER PRIMARY KEY REFERENCES events (seq),
     payment_id TEXT NOT NULL
   )`,
  'CREATE INDEX deferred_events_by_payment ON deferred_events (payment_id, event_seq)',
];

/**
 * WAL lets reads proceed during a write; for ":memory:" SQLite keeps its in-memory mode.
 * Switching the mode of a new file while another process does the same fails with SQLITE_BUSY
 * without consulting busy_timeout, so this retries until the same deadline.
 */
function enableWriteAheadLog(db: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MILLISECONDS;
  for (;;) {
    try {
      db.run('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      const stillBusy = error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY';
      if (!stillBusy || Date.now() >= deadline) throw error;
      Bun.sleepSync(WAL_RETRY_DELAY_MILLISECONDS);
    }
  }
}

/**
 * Opens (creating when absent) the ledger database and its schema.
 * Several processes may do this on one new path at once: schema creation runs inside one
 * immediate transaction, so exactly one creates it and the others see it done.
 */
export function openDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.run(SET_BUSY_TIMEOUT);
    db.run('PRAGMA foreign_keys = ON');
    enableWriteAheadLog(db);
    runInTransaction(db, () => {
      const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
      if (row?.user_version !== SCHEMA_VERSION) {
        for (const statement of SCHEMA_STATEMENTS) db.run(statement);
        db.run(SET_SCHEMA_VERSION);
      }
      return succeed(undefined);
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Runs `work` in one write transaction taken up front (BEGIN IMMEDIATE), so requests from any
 * number of connections run one at a time. Commits when `work` returns ok, rolls back when it
 * returns a failure, and rolls back and rethrows when `work` throws.
 */
export function runInTransaction<Value, Failure>(db: Database, work: () => Result<Value, Failure>): Result<Value, Failure> {
  db.run('BEGIN IMMEDIATE');
  try {
    const outcome = work();
    db.run(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  } catch (error) {
    if (db.inTransaction) db.run('ROLLBACK');
    throw error;
  }
}
