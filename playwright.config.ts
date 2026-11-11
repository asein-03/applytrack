import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testIgnore: '**/desktop/**', testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 }, channel: process.env.PLAYWRIGHT_CHANNEL || undefined, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI,
    env: { DATA_DIR: 'test-results/runtime', APP_STORAGE_MODE: 'local' }, timeout: 60000,
  },
});
