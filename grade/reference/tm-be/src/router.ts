import { apiFailure, type ApiFailure } from './apiError.ts';
import { fail, succeed, type Result } from './result.ts';

export type Route =
  | { kind: 'webhook' }
  | { kind: 'balance'; merchantId: string }
  | { kind: 'payment'; paymentId: string };

const notFound = () => fail(apiFailure('not_found', 'No such path'));

/** Decodes one path segment; a missing, empty or malformed one names no resource. */
function decodeSegment(segment: string | undefined): Result<string, ApiFailure> {
  if (segment === undefined || segment.length === 0) return notFound();
  try {
    return succeed(decodeURIComponent(segment));
  } catch {
    return notFound();
  }
}

function methodAllowed(request: Request, method: string): Result<void, ApiFailure> {
  return request.method === method ? succeed(undefined) : fail(apiFailure('method_not_allowed', `Use ${method} on this path`));
}

/**
 * Decides the route from path and method only. The path is split before it is decoded, so an
 * encoded slash stays inside its segment; the query string is not part of the pathname.
 */
export function matchRoute(request: Request): Result<Route, ApiFailure> {
  const segments = new URL(request.url).pathname.split('/');
  const [leading, resource, identifier, ...rest] = segments;
  if (leading !== '' || rest.length > 0) return notFound();

  if (resource === 'webhooks' && identifier === undefined) {
    const allowed = methodAllowed(request, 'POST');
    return allowed.ok ? succeed({ kind: 'webhook' }) : allowed;
  }
  if (resource === 'balances' || resource === 'payments') {
    const decoded = decodeSegment(identifier);
    if (!decoded.ok) return decoded;
    const allowed = methodAllowed(request, 'GET');
    if (!allowed.ok) return allowed;
    return succeed(resource === 'balances' ? { kind: 'balance', merchantId: decoded.value } : { kind: 'payment', paymentId: decoded.value });
  }
  return notFound();
}
