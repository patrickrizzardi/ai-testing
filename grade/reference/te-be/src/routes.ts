import { failWith, type AppError } from './errors.ts';
import { succeed, type Result } from './result.ts';

export type Route =
  | { name: 'createUser' }
  | { name: 'createBudget'; userIdText: string }
  | { name: 'createSpend'; userIdText: string }
  | { name: 'getSummary'; userIdText: string; categoryText: string };

type RouteShape = {
  pattern: RegExp;
  method: 'GET' | 'POST';
  build(captures: string[]): Route;
};

// `[^/]+` makes `{userId}` and `{category}` any non-empty text without `/`; the anchors make
// paths match exactly (no trailing slash, no extra segment).
const ROUTE_SHAPES: readonly RouteShape[] = [
  { pattern: /^\/users$/, method: 'POST', build: () => ({ name: 'createUser' }) },
  {
    pattern: /^\/users\/([^/]+)\/budgets$/,
    method: 'POST',
    build: ([userIdText = '']) => ({ name: 'createBudget', userIdText }),
  },
  {
    pattern: /^\/users\/([^/]+)\/spends$/,
    method: 'POST',
    build: ([userIdText = '']) => ({ name: 'createSpend', userIdText }),
  },
  {
    pattern: /^\/users\/([^/]+)\/budgets\/([^/]+)\/summary$/,
    method: 'GET',
    build: ([userIdText = '', categoryText = '']) => ({ name: 'getSummary', userIdText, categoryText }),
  },
];

/** Path first, then method: an unknown path is 404 whatever the method. O(1) time and memory. */
export function matchRoute(pathname: string, method: string): Result<Route, AppError> {
  for (const shape of ROUTE_SHAPES) {
    const match = shape.pattern.exec(pathname);
    if (match === null) continue;
    if (method !== shape.method) return failWith('method_not_allowed', `${method} is not allowed on this path`);
    return succeed(shape.build(match.slice(1)));
  }
  return failWith('not_found', 'unknown route');
}
