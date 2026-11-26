import { apiFailure, type ApiFailure } from './apiError.ts';
import { fail, succeed, type Result } from './result.ts';

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses UTF-8 JSON text that must contain an object. */
export function parseJsonObject(text: string): Result<JsonObject, ApiFailure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(apiFailure('invalid_input', `Body is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`));
  }
  return isJsonObject(parsed) ? succeed(parsed) : fail(apiFailure('invalid_input', 'Body must be a JSON object'));
}

/** Decodes bytes as strict UTF-8. A leading BOM is kept (and then fails JSON parsing), not dropped. */
export function decodeUtf8(bytes: Uint8Array): Result<string, ApiFailure> {
  try {
    return succeed(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return fail(apiFailure('invalid_input', 'Body is not valid UTF-8'));
  }
}

/**
 * Serialises a parsed JSON value with object keys sorted, so two bodies that are equal as JSON
 * values (whitespace, key order, number spelling aside) give the same string.
 * O(n log n) time and O(n) memory for n JSON nodes: sorts the keys of each object.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}
