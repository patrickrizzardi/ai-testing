// Tier: High (validator of untrusted environment input).
import { expect, test } from 'bun:test';
import { readServerConfig } from '../src/serverConfig.ts';

const FEES_JSON = '{"percentBps":290,"fixedMinor":{"USD":30,"EUR":25,"JPY":0,"BHD":300}}';

test('an empty DB_PATH is rejected, naming DB_PATH', () => {
  // Bug caught: "" opens a temporary SQLite database, so ledger and event ids vanish on restart.
  const config = readServerConfig({ WEBHOOK_SECRET: 'whsec', FEES_JSON, DB_PATH: '' });
  expect(config.ok ? 'accepted' : config.error).toContain('DB_PATH');
});
