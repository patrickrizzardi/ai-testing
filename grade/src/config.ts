import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, type Result } from "./types.ts";

export const GATE_IDS = ["duct-tape", "swallowed-error", "sql-injection", "duplication"] as const;
export type GateId = (typeof GATE_IDS)[number];

export const DEFAULT_MIN_TOKENS = 60;

export interface TaskConfig {
  /** Files the solution must contain, relative to the solution directory. */
  entries: string[];
  /** Gates that apply to this task, in report order. */
  gates: GateId[];
  /** Minimum duplicated token run that counts as copy-paste. */
  duplicationMinTokens: number;
}

const TASKS_DIRECTORY = join(import.meta.dir, "..", "tasks");

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Config shape (grade/tasks/<id>.json):
 *   { "entries": ["src/app.ts"],
 *     "gates": ["duct-tape", ...]      // optional, default: all four
 *     "duplication": { "minTokens": 60 } // optional
 *   }
 */
export function parseTaskConfig(raw: unknown, origin: string): Result<TaskConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(`${origin}: must be a JSON object`);
  const record = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !["entries", "gates", "duplication"].includes(key));
  if (unknownKeys.length > 0) return fail(`${origin}: unknown key "${unknownKeys[0]}"`);

  const entries = record.entries;
  if (!isStringArray(entries) || entries.length === 0) return fail(`${origin}: "entries" must be a non-empty array of paths`);

  let gates: GateId[] = [...GATE_IDS];
  if (record.gates !== undefined) {
    if (!isStringArray(record.gates)) return fail(`${origin}: "gates" must be an array of gate ids`);
    const unknownGate = record.gates.find((gate) => !(GATE_IDS as readonly string[]).includes(gate));
    if (unknownGate !== undefined) return fail(`${origin}: unknown gate "${unknownGate}" (known: ${GATE_IDS.join(", ")})`);
    gates = GATE_IDS.filter((gate) => (record.gates as string[]).includes(gate));
  }

  let duplicationMinTokens = DEFAULT_MIN_TOKENS;
  if (record.duplication !== undefined) {
    const duplication = record.duplication as Record<string, unknown> | null;
    const minTokens = duplication?.minTokens;
    if (typeof duplication !== "object" || duplication === null || !Number.isInteger(minTokens) || (minTokens as number) < 1) {
      return fail(`${origin}: "duplication" must be { "minTokens": <positive integer> }`);
    }
    duplicationMinTokens = minTokens as number;
  }
  return ok({ entries, gates, duplicationMinTokens });
}

export function loadTaskConfig(taskId: string): Result<TaskConfig> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(taskId)) return fail(`invalid task id "${taskId}" (expected like te-be)`);
  const configPath = join(TASKS_DIRECTORY, `${taskId}.json`);
  if (!existsSync(configPath)) return fail(`no config for task "${taskId}": ${configPath} does not exist`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return fail(`${configPath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseTaskConfig(raw, configPath);
}
