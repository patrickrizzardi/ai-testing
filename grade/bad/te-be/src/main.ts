import { createApp } from './app.ts';

export function startServer(): ReturnType<typeof Bun.serve> {
  const app = createApp({ dbPath: process.env['DB_PATH'] ?? 'budget.db' });
  return Bun.serve({
    port: Number(process.env['PORT'] ?? 3000),
    fetch: app.fetch,
  });
}

if (import.meta.main) startServer();
