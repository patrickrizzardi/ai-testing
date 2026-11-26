import { describe, expect, test } from "bun:test";
import { scanSwallowedError } from "./swallowed-error.ts";

// High tier (validator). Bugs caught: an error handler that discards the error passing the gate,
// or a handler that reports/rethrows/returns the error as a value failing it.
const scan = (text: string) => scanSwallowedError([{ path: "src/a.ts", text }]);

const positives: [name: string, code: string][] = [
  ["empty catch", "try { f(); } catch {}"],
  ["empty catch with binding", "try { f(); } catch (err) {}"],
  ["catch holding only a comment", "try { f(); } catch (err) { /* ignore */ }"],
  ["catch returning null", "function g() { try { return f(); } catch (err) { return null; } }"],
  ["catch returning undefined", "function g() { try { return f(); } catch { return undefined; } }"],
  ["catch with bare return", "function g() { try { f(); } catch { return; } }"],
  ["catch returning false", "function g() { try { return f(); } catch { return false; } }"],
  ["catch returning a number", "function g() { try { return f(); } catch { return 0; } }"],
  ["catch returning a negative number", "function g() { try { return f(); } catch { return -1; } }"],
  ["catch returning a string", "function g() { try { return f(); } catch { return 'n/a'; } }"],
  ["catch returning an empty array", "function g() { try { return f(); } catch { return []; } }"],
  ["catch returning an empty object", "function g() { try { return f(); } catch { return {}; } }"],
  ["catch returning void 0", "function g() { try { return f(); } catch { return void 0; } }"],
  [".catch with empty arrow", "p.catch(() => {});"],
  [".catch with empty function", "p.catch(function () {});"],
  [".catch with arrow returning null", "p.catch(() => null);"],
  [".catch with arrow returning undefined", "p.catch((err) => undefined);"],
  [".catch with block returning a literal", "p.catch(() => { return 0; });"],
];

const negatives: [name: string, code: string][] = [
  ["catch rethrowing", "try { f(); } catch (err) { throw err; }"],
  ["catch returning the error as a value", "function g() { try { return f(); } catch (err) { return { ok: false, error: String(err) }; } }"],
  ["catch returning a call", "function g() { try { return f(); } catch (err) { return fail(String(err)); } }"],
  ["catch returning the error", "function g() { try { return f(); } catch (err) { return err; } }"],
  ["catch logging then returning a default", "function g() { try { return f(); } catch (err) { report(err); return null; } }"],
  ["catch with other statement", "try { f(); } catch (err) { report(err); }"],
  [".catch with a handler reference", "p.catch(handle);"],
  [".catch with a reporting arrow", "p.catch((err) => report(err));"],
  [".catch rethrowing", "p.catch((err) => { throw err; });"],
  [".then with an empty callback", "p.then(() => {});"],
  ["empty arrow that is not a catch handler", "const noop = () => {};"],
  ["catch property that is not called", "const handler = p.catch;"],
];

describe("swallowed-error scanner", () => {
  test.each(positives)("flags %s", (_name, code) => {
    expect(scan(code).length).toBe(1);
  });

  test.each(negatives)("passes %s", (_name, code) => {
    expect(scan(code)).toEqual([]);
  });

  test("names file and 1-based line", () => {
    const findings = scan("export function f() {\n  try {\n    g();\n  } catch {}\n}");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "src/a.ts", line: 4 });
  });
});
