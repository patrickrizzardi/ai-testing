import { Database } from 'bun:sqlite';
import type { Budget, NewBudget, NewSpend, NewUser, Spend, SpendInstant, User } from './domain.ts';
import { failWith, type AppError } from './errors.ts';
import { succeed, type Result } from './result.ts';

export type Store = {
  createUser(newUser: NewUser): User;
  findUser(userId: number): Result<User, AppError>;
  createBudget(userId: number, newBudget: NewBudget): Result<Budget, AppError>;
  findBudget(userId: number, category: string): Result<Budget, AppError>;
  createSpend(userId: number, newSpend: NewSpend): Result<Spend, AppError>;
  listSpendInstants(userId: number, category: string): SpendInstant[];
  close(): void;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    time_zone TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS budgets (
    user_id INTEGER NOT NULL REFERENCES users (id),
    category TEXT NOT NULL,
    limit_cents INTEGER NOT NULL,
    PRIMARY KEY (user_id, category)
  );
  CREATE TABLE IF NOT EXISTS spends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    spent_at TEXT NOT NULL,
    spent_at_epoch_ms INTEGER NOT NULL,
    FOREIGN KEY (user_id, category) REFERENCES budgets (user_id, category)
  );
  CREATE INDEX IF NOT EXISTS spends_by_user_and_category ON spends (user_id, category);
`;

type UserRow = { id: number; name: string; time_zone: string };
type BudgetRow = { category: string; limit_cents: number };
type SpendInstantRow = { amount_cents: number; spent_at_epoch_ms: number };

/** Opens (creating if missing) the database at `dbPath`. Unexpected database failures are thrown. */
export function openStore(dbPath: string): Store {
  const database = new Database(dbPath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(SCHEMA);

  const insertUser = database.prepare<{ id: number }, [string, string]>(
    'INSERT INTO users (name, time_zone) VALUES (?, ?) RETURNING id',
  );
  const selectUser = database.prepare<UserRow, [number]>('SELECT id, name, time_zone FROM users WHERE id = ?');
  const insertBudget = database.prepare<never, [number, string, number]>(
    'INSERT INTO budgets (user_id, category, limit_cents) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  const selectBudget = database.prepare<BudgetRow, [number, string]>(
    'SELECT category, limit_cents FROM budgets WHERE user_id = ? AND category = ?',
  );
  // One statement, so the budget check and the insert cannot be split by another writer.
  const insertSpendWithBudget = database.prepare<{ id: number }, [number, string, number, string, number]>(
    `INSERT INTO spends (user_id, category, amount_cents, spent_at, spent_at_epoch_ms)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE EXISTS (SELECT 1 FROM budgets WHERE user_id = ?1 AND category = ?2)
     RETURNING id`,
  );
  const selectSpendInstants = database.prepare<SpendInstantRow, [number, string]>(
    'SELECT amount_cents, spent_at_epoch_ms FROM spends WHERE user_id = ? AND category = ?',
  );

  return {
    createUser(newUser) {
      const row = insertUser.get(newUser.name, newUser.timeZone);
      if (row === null) throw new Error('INSERT ... RETURNING produced no row');
      return { id: row.id, ...newUser };
    },
    findUser(userId) {
      const row = selectUser.get(userId);
      if (row === null) return failWith('not_found', 'user not found');
      return succeed({ id: row.id, name: row.name, timeZone: row.time_zone });
    },
    createBudget(userId, newBudget) {
      const { changes } = insertBudget.run(userId, newBudget.category, newBudget.limitCents);
      if (changes === 0) return failWith('budget_exists', 'a budget for this category already exists');
      return succeed(newBudget);
    },
    findBudget(userId, category) {
      const row = selectBudget.get(userId, category);
      if (row === null) return failWith('not_found', 'budget not found');
      return succeed({ category: row.category, limitCents: row.limit_cents });
    },
    createSpend(userId, newSpend) {
      const row = insertSpendWithBudget.get(
        userId,
        newSpend.category,
        newSpend.amountCents,
        newSpend.spentAt,
        newSpend.spentAtEpochMs,
      );
      if (row === null) return failWith('no_budget', 'no budget exists for this category');
      return succeed({
        id: row.id,
        category: newSpend.category,
        amountCents: newSpend.amountCents,
        spentAt: newSpend.spentAt,
      });
    },
    listSpendInstants(userId, category) {
      try {
        return selectSpendInstants
          .all(userId, category)
          .map((row) => ({ amountCents: row.amount_cents, spentAtEpochMs: row.spent_at_epoch_ms }));
      } catch {
        return [];
      }
    },
    close() {
      database.close();
    },
  };
}
