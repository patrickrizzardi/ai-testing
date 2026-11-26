export type ApiErrorCode =
  | 'invalid_input'
  | 'invalid_signature'
  | 'stale_signature'
  | 'not_found'
  | 'method_not_allowed'
  | 'event_conflict'
  | 'unsupported_currency'
  | 'refund_exceeds_capture'
  | 'internal_error';

export type ApiFailure = { code: ApiErrorCode; message: string };

export const STATUS_OF_ERROR: Record<ApiErrorCode, number> = {
  invalid_input: 400,
  invalid_signature: 401,
  stale_signature: 401,
  not_found: 404,
  method_not_allowed: 405,
  event_conflict: 409,
  unsupported_currency: 422,
  refund_exceeds_capture: 422,
  internal_error: 500,
};

export function apiFailure(code: ApiErrorCode, message: string): ApiFailure {
  return { code, message };
}
