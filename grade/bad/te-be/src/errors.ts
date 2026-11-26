import { fail, type Failure } from './result.ts';

export type ErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'method_not_allowed'
  | 'budget_exists'
  | 'no_budget'
  | 'internal_error';

export type AppError = { code: ErrorCode; message: string };

export const STATUS_BY_ERROR_CODE: Record<ErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  method_not_allowed: 405,
  budget_exists: 409,
  no_budget: 422,
  internal_error: 500,
};

export function failWith(code: ErrorCode, message: string): Failure<AppError> {
  return fail({ code, message });
}

export function invalidInput(message: string): Failure<AppError> {
  return failWith('invalid_input', message);
}
