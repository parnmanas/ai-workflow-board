import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: process.env.PLAYWRIGHT_TEST_MATCH || 'agent-detail-scroll.e2e.mjs',
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    launchOptions: process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : undefined,
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    cwd: '..',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
