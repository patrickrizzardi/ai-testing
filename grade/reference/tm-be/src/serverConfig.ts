import { validateFeeConfig } from './feeConfig.ts';
import { fail, succeed, type Result } from './result.ts';
import type { FeeConfig } from './types.ts';

export type ServerConfig = { port: number; dbPath: string; secret: string; fees: FeeConfig };

const DEFAULT_PORT = 3000;
const DEFAULT_DB_PATH = './ledger.db';
const MAX_PORT = 65535;

function readPort(text: string | undefined): Result<number, string> {
  if (text === undefined) return succeed(DEFAULT_PORT);
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(port) && port <= MAX_PORT ? succeed(port) : fail(`PORT must be an integer from 0 to ${MAX_PORT}`);
}

function readFees(text: string | undefined): Result<FeeConfig, string> {
  if (text === undefined) return fail('FEES_JSON is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('FEES_JSON is not valid JSON');
  }
  const fees = validateFeeConfig(parsed);
  return fees.ok ? fees : fail(`FEES_JSON is not a valid FeeConfig: ${fees.error}`);
}

/** Reads and validates the environment; a failure message names the offending variable. */
export function readServerConfig(env: Record<string, string | undefined>): Result<ServerConfig, string> {
  const port = readPort(env.PORT);
  if (!port.ok) return port;
  const secret = env.WEBHOOK_SECRET;
  if (secret === undefined || secret.length === 0) return fail('WEBHOOK_SECRET is required');
  const fees = readFees(env.FEES_JSON);
  if (!fees.ok) return fees;
  return succeed({ port: port.value, dbPath: env.DB_PATH ?? DEFAULT_DB_PATH, secret, fees: fees.value });
}
