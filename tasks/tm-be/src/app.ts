export type Currency = 'USD' | 'EUR' | 'JPY' | 'BHD';

export type FeeConfig = {
  /** Integer 0..10000. */
  percentBps: number;
  /** Integer >= 0 for each currency. */
  fixedMinor: Record<Currency, number>;
};

export type AppOptions = {
  dbPath: string;
  secret: string;
  fees: FeeConfig;
  now?: () => Date;
  hooks?: { beforeCommit?: (eventId: string) => void };
};

export type App = {
  fetch(request: Request): Promise<Response>;
  close(): void;
};

export function createApp(options: AppOptions): App {
  throw new Error('not implemented');
}
