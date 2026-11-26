export interface Finding {
  /** Path relative to the solution directory, forward slashes. */
  file: string;
  /** 1-based line. */
  line: number;
  message: string;
}

export interface SourceFile {
  /** Path relative to the solution directory, forward slashes. */
  path: string;
  text: string;
}

export interface LayoutResult {
  pass: boolean;
  findings: Finding[];
}

export interface TypecheckResult {
  pass: boolean;
  errors: string[];
}

export interface GateResult {
  id: string;
  pass: boolean;
  findings: Finding[];
}

export interface TestsResult {
  passed: number;
  failed: number;
  total: number;
  failures: string[];
}

export interface GradeReport {
  task: string;
  solutionDir: string;
  layout: LayoutResult;
  typecheck: TypecheckResult;
  gates: GateResult[];
  tests: TestsResult;
  rightFirstTime: boolean;
}

/**
 * Errors cross module boundaries as values. An `ok: false` result is an
 * infrastructure or usage problem (CLI exit code 2), never a solution failure.
 */
export type Result<Value> = { ok: true; value: Value } | { ok: false; error: string };

export function ok<Value>(value: Value): Result<Value> {
  return { ok: true, value };
}

export function fail<Value = never>(error: string): Result<Value> {
  return { ok: false, error };
}
