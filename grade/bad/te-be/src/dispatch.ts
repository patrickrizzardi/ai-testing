import { createBudget, createSpend, createUser, getSummary, type HandlerDependencies, type HandlerResult } from './handlers.ts';
import { errorReply, INTERNAL_ERROR_REPLY, jsonResponse, type JsonReply } from './responses.ts';
import { matchRoute } from './routes.ts';
import { parseUserId } from './validation.ts';

async function dispatchRoute(dependencies: HandlerDependencies, request: Request): Promise<HandlerResult> {
  const route = matchRoute(new URL(request.url).pathname, request.method);
  if (!route.ok) return route;
  if (route.value.name === 'createUser') return createUser(dependencies, request);

  const userId = parseUserId(route.value.userIdText);
  if (!userId.ok) return userId;
  const user = dependencies.store.findUser(userId.value);
  if (!user.ok) return user;

  switch (route.value.name) {
    case 'createBudget':
      return createBudget(dependencies, user.value, request);
    case 'createSpend':
      return createSpend(dependencies, user.value, request);
    case 'getSummary':
      return getSummary(dependencies, user.value, route.value.categoryText);
  }
}

/** The one place thrown failures (database errors included) are caught and turned into a 500. */
export function createDispatcher(dependencies: HandlerDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    let reply: JsonReply;
    try {
      const result = await dispatchRoute(dependencies, request);
      reply = result.ok ? result.value : errorReply(result.error);
    } catch (error) {
      console.error('unexpected failure while handling a request', error);
      reply = INTERNAL_ERROR_REPLY;
    }
    return jsonResponse(reply);
  };
}
