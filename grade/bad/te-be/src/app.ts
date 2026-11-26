import { createDispatcher } from './dispatch.ts';
import { openStore } from './store.ts';

export type CreateAppOptions = {
  dbPath: string;
  now?: () => Date;
};

export type App = {
  fetch(request: Request): Promise<Response>;
  close(): void;
};

export function createApp({ dbPath, now = () => new Date() }: CreateAppOptions): App {
  const store = openStore(dbPath);
  return {
    fetch: createDispatcher({ store, now }),
    close: () => store.close(),
  };
}
