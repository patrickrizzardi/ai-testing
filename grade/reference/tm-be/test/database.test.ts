// Tier: High (idempotency and atomicity, data integrity). Real SQLite files, no mocks.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase, runInTransaction } from '../src/database.ts';
import { recordEvent } from '../src/eventStore.ts';
import { fail, succeed } from '../src/result.ts';

let directory: string;
let opened: Database[];
const open = (dbPath: string) => {
  const db = openDatabase(dbPath);
  opened.push(db);
  return db;
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tm-be-unit-'));
  opened = [];
});
afterEach(() => {
  for (const db of opened) db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('idempotency guard', () => {
  test('the unique key lets exactly one connection record an event id and shows the others the first body', () => {
    // Bug caught: a check-then-insert guard (read, then write) that lets a retry record the id twice. Tier: High.
    const dbPath = join(directory, 'ledger.db');
    const first = open(dbPath);
    const second = open(dbPath);
    expect(recordEvent(first, 'evt_1', '{"a":1}').recorded).toBe(true);
    expect(recordEvent(second, 'evt_1', '{"a":2}')).toEqual({ recorded: false, existingCanonicalBody: '{"a":1}' });
    expect(recordEvent(second, 'evt_2', '{"a":2}').recorded).toBe(true);
  });
});

describe('runInTransaction', () => {
  const countEvents = (db: Database) => db.query<{ total: number }, []>('SELECT count(*) AS total FROM events').get()?.total;

  test('commits on success; rolls back on a failure value; rolls back and rethrows on a throw', () => {
    // Bug caught: the event id staying recorded after a rejected or crashed request (the event could then never be retried). Tier: High.
    const db = open(join(directory, 'ledger.db'));
    runInTransaction(db, () => {
      recordEvent(db, 'kept', '{}');
      return succeed(undefined);
    });
    runInTransaction(db, () => {
      recordEvent(db, 'rejected', '{}');
      return fail('refused');
    });
    expect(() =>
      runInTransaction(db, () => {
        recordEvent(db, 'crashed', '{}');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(countEvents(db)).toBe(1);
    expect(recordEvent(db, 'crashed', '{}').recorded).toBe(true);
  });
});
