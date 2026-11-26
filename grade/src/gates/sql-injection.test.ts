import { describe, expect, test } from "bun:test";
import { scanSqlInjection } from "./sql-injection.ts";

// High tier (validator, untrusted input). Bugs caught: interpolated SQL passing the gate on any
// of the listed methods, or parameterised / non-SQL calls (Map.get) failing a correct solution.
const scan = (text: string) => scanSqlInjection([{ path: "src/a.ts", text }]);

const methods = ["query", "prepare", "run", "exec", "all", "get", "values"];

const positives: [name: string, code: string][] = [
  ...methods.map((method): [string, string] => [`.${method} with an interpolated template`, `db.${method}(\`SELECT * FROM t WHERE id = \${id}\`);`]),
  ["concatenation with a variable", "db.prepare('SELECT * FROM t WHERE id = ' + id);"],
  ["concatenation of several parts", "db.exec('DELETE FROM t WHERE a = ' + a + ' AND b = ' + b);"],
  ["concatenation with a template operand", "db.query('SELECT ' + `${column} FROM t`);"],
  ["insert with interpolation", "db.run(`INSERT INTO t (name) VALUES ('${name}')`);"],
  ["parenthesised concatenation", "db.query(('SELECT * FROM t WHERE id = ' + id));"],
  ["as-cast template", "db.query(`SELECT * FROM t WHERE id = ${id}` as string);"],
  ["chained call", "db.prepare(`SELECT * FROM t WHERE id = ${id}`).get();"],
  ["extra arguments after the sql", "db.query(`SELECT * FROM t WHERE id = ${id}`, []);"],
];

const negatives: [name: string, code: string][] = [
  ["plain string", "db.query('SELECT 1');"],
  ["template without substitutions", "db.query(`SELECT 1`);"],
  ["concatenation of literals only", "db.query('SELECT * ' + 'FROM t');"],
  ["parameterised query", "db.query('SELECT * FROM t WHERE id = ?', [id]);"],
  ["parameterised prepare/get", "db.prepare('SELECT * FROM t WHERE id = ?').get(id);"],
  ["tagged template", "db.query(sql`SELECT * FROM t WHERE id = ${id}`);"],
  ["Map.get with an interpolated key", "cache.get(`user:${id}`);"],
  ["RegExp.exec with an interpolated subject", "pattern.exec(`${a} ${b}`);"],
  ["identifier argument", "db.query(statement);"],
  ["other method name", "db.fetch(`SELECT * FROM t WHERE id = ${id}`);"],
  ["bare function, not a method", "query(`SELECT * FROM t WHERE id = ${id}`);"],
  ["no arguments", "db.all();"],
  ["interpolation in a later argument only", "db.query('SELECT * FROM t WHERE id = ?', [`${id}`]);"],
];

describe("sql-injection scanner", () => {
  test.each(positives)("flags %s", (_name, code) => {
    expect(scan(code).length).toBe(1);
  });

  test.each(negatives)("passes %s", (_name, code) => {
    expect(scan(code)).toEqual([]);
  });

  test("names file and 1-based line", () => {
    const findings = scan("const a = 1;\ndb.query(\n  `SELECT * FROM t WHERE id = ${id}`,\n);");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "src/a.ts", line: 3 });
  });
});
