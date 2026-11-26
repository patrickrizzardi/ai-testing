export type ValueRecord = { [field: string]: Value };

export type Value = null | boolean | number | string | Value[] | ValueRecord;

export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type IoEntry = { value: Value; latencyMs: number };

export type RunOptions = {
  clock: Clock;
  io?: Record<string, IoEntry>;
};

export type RunError = {
  kind: "SyntaxError" | "RuntimeError";
  message: string;
  line: number;
  column: number;
};

export type RunResult = {
  output: string[];
  error: null | RunError;
  heap: { allocs: number; frees: number };
};

export async function run(source: string, options: RunOptions): Promise<RunResult> {
  throw new Error('not implemented');
}
