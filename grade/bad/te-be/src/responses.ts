import { STATUS_BY_ERROR_CODE, type AppError } from './errors.ts';

export type JsonReply = { status: number; body: unknown };

export function jsonResponse(reply: JsonReply): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorReply(error: AppError): JsonReply {
  return {
    status: STATUS_BY_ERROR_CODE[error.code],
    body: { code: error.code, message: error.message },
  };
}

// A fixed message: the caught error may carry SQL or paths, which must not leave the server.
export const INTERNAL_ERROR_REPLY: JsonReply = errorReply({
  code: 'internal_error',
  message: 'The server failed to process the request',
});
