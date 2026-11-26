interface Database {
  query(sql: string, parameters?: unknown[]): unknown[];
}

export function add(left: number, right: number): number {
  return left + right;
}

export function findUser(database: Database, userId: string): unknown[] {
  return database.query(`SELECT * FROM users WHERE id = '${userId}'`);
}

export function findUserSafely(database: Database, userId: string): unknown[] {
  return database.query("SELECT * FROM users WHERE id = ?", [userId]);
}
