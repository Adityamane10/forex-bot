import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Unit tests must be hermetic: never hit real market data providers.
    env: {
      MARKET_DATA_PROVIDER: 'DEMO',
      CRYPTO_MARKET_DATA_PROVIDER: 'DEMO',
      NEWS_PROVIDER: 'NONE',
      ECONOMIC_CALENDAR_PROVIDER: 'NONE',
      // Tests are ephemeral: disable file persistence so state never leaks
      // between runs or from the live backend's .data/store.json.
      STORE_FILE: '',
      // Force in-memory store/cache: the live backend's .env may point at a
      // running Mongo/Redis whose real user settings would leak into tests.
      MONGODB_URI: '',
      REDIS_URL: '',
    },
  },
});
