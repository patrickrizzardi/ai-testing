export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'JPY', 'BHD'] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

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

export function isSupportedCurrency(value: string): value is Currency {
  return SUPPORTED_CURRENCIES.some((currency) => currency === value);
}
