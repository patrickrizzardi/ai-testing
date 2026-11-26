import { STATUS_OF_ERROR, type ApiFailure } from './apiError.ts';

export type ReceiveOutcome = 'processed' | 'ignored' | 'deferred' | 'duplicate';

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function errorResponse(failure: ApiFailure): Response {
  return jsonResponse(STATUS_OF_ERROR[failure.code], { code: failure.code, message: failure.message });
}

export function outcomeResponse(outcome: ReceiveOutcome): Response {
  return jsonResponse(outcome === 'deferred' ? 202 : 200, { status: outcome });
}
