import { afterEach, expect, test } from 'bun:test';
import { createApp, type App } from './app.ts';

const openApps: App[] = [];
afterEach(() => openApps.splice(0).forEach((app) => app.close()));

async function send(app: App, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  return { status: response.status, json: await response.json() };
}

// Tier: Medium (one endpoint walk-through). Catches: a miswired route, validation, store or summary module.
test('a user, a budget and a spend lead to the documented summary; bad requests get the error shape', async () => {
  const app = createApp({ dbPath: ':memory:', now: () => new Date('2026-03-14T20:00:00Z') });
  openApps.push(app);

  expect((await send(app, 'POST', '/users', { name: 'Ada', timeZone: 'Europe/Paris' })).status).toBe(201);
  expect((await send(app, 'POST', '/users/1/budgets', { category: 'groceries', limitCents: 50_000 })).status).toBe(201);
  const spend = await send(app, 'POST', '/users/1/spends', {
    category: 'groceries',
    amountCents: 12_500,
    spentAt: '2026-03-14T18:30:00+01:00',
  });
  expect(spend.json).toEqual({ id: 1, category: 'groceries', amountCents: 12_500, spentAt: '2026-03-14T18:30:00+01:00' });

  expect(await send(app, 'GET', '/users/1/budgets/groceries/summary')).toEqual({
    status: 200,
    json: {
      category: 'groceries',
      month: '2026-03',
      limitCents: 50_000,
      spentCents: 12_500,
      remainingCents: 37_500,
      daysLeft: 18,
      dailyAllowanceCents: 2_083,
    },
  });

  const duplicate = await send(app, 'POST', '/users/1/budgets', { category: 'groceries', limitCents: 1 });
  expect([duplicate.status, (duplicate.json as { code: string }).code]).toEqual([409, 'budget_exists']);
});
