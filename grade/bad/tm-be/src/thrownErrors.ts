import { internalFailure, type ApiFailure } from './apiError.ts';
import { fail, type Result } from './result.ts';

/**
 * The boundary of the database-backed modules: a thrown error (a SQLite failure, a throwing
 * beforeCommit hook) leaves as the internal_error value, never as an exception. The thrown
 * message goes to the log only, so no SQL text or stored data reaches a response body.
 */
export function catchThrown<Value>(work: () => Result<Value, ApiFailure>): Result<Value, ApiFailure> {
  try {
    return work();
  } catch (error) {
    console.error('tm-be: unexpected failure while using the database', error);
    return fail(internalFailure());
  }
}
