import { createApp } from './app.ts';
import { readServerConfig } from './serverConfig.ts';

export type RunningServer = {
  port: number;
  stop(): void;
};

export function startServer(env: Record<string, string | undefined>): RunningServer {
  const config = readServerConfig(env);
  if (!config.ok) throw new Error(config.error);
  const app = createApp({ dbPath: config.value.dbPath, secret: config.value.secret, fees: config.value.fees });
  try {
    const server = Bun.serve({ port: config.value.port, fetch: (request) => app.fetch(request) });
    if (server.port === undefined) throw new Error('server is not listening on a TCP port');
    return {
      port: server.port,
      stop() {
        void server.stop(true);
        app.close();
      },
    };
  } catch (error) {
    app.close();
    throw error;
  }
}

if (import.meta.main) {
  try {
    startServer(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
