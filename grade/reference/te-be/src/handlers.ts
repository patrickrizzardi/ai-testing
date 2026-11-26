import type { User } from './domain.ts';
import type { AppError } from './errors.ts';
import { failWith } from './errors.ts';
import type { JsonReply } from './responses.ts';
import { succeed, type Result } from './result.ts';
import type { Store } from './store.ts';
import { summarizeBudget } from './summary.ts';
import { checkCategory, parseJsonObject, parseNewBudget, parseNewSpend, parseNewUser } from './validation.ts';

export type HandlerDependencies = { store: Store; now: () => Date };
export type HandlerResult = Result<JsonReply, AppError>;

async function readJsonBody(request: Request) {
  return parseJsonObject(await request.text());
}

export async function createUser({ store }: HandlerDependencies, request: Request): Promise<HandlerResult> {
  const body = await readJsonBody(request);
  if (!body.ok) return body;
  const newUser = parseNewUser(body.value);
  if (!newUser.ok) return newUser;
  return succeed({ status: 201, body: store.createUser(newUser.value) });
}

export async function createBudget({ store }: HandlerDependencies, user: User, request: Request): Promise<HandlerResult> {
  const body = await readJsonBody(request);
  if (!body.ok) return body;
  const newBudget = parseNewBudget(body.value);
  if (!newBudget.ok) return newBudget;
  const budget = store.createBudget(user.id, newBudget.value);
  if (!budget.ok) return budget;
  return succeed({ status: 201, body: budget.value });
}

export async function createSpend({ store }: HandlerDependencies, user: User, request: Request): Promise<HandlerResult> {
  const body = await readJsonBody(request);
  if (!body.ok) return body;
  const newSpend = parseNewSpend(body.value);
  if (!newSpend.ok) return newSpend;
  const spend = store.createSpend(user.id, newSpend.value);
  if (!spend.ok) return spend;
  return succeed({ status: 201, body: spend.value });
}

/** Reads the clock once, so the month, `daysLeft` and the spend filter all see one instant. */
export function getSummary({ store, now }: HandlerDependencies, user: User, categoryText: string): HandlerResult {
  const category = checkCategory(categoryText);
  if (!category.ok) return failWith('not_found', 'budget not found');
  const budget = store.findBudget(user.id, category.value);
  if (!budget.ok) return budget;
  const summary = summarizeBudget({
    budget: budget.value,
    spends: store.listSpendInstants(user.id, category.value),
    timeZone: user.timeZone,
    nowEpochMs: now().getTime(),
  });
  return succeed({ status: 200, body: summary });
}
