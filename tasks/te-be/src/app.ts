export type CreateAppOptions = {
  dbPath: string;
  now?: () => Date;
};

export type App = {
  fetch(request: Request): Promise<Response>;
  close(): void;
};

export function createApp(options: CreateAppOptions): App {
  throw new Error('not implemented');
}
