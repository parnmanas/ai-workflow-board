import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: !process.env.PLAYWRIGHT_TEST_MATCH || process.env.PLAYWRIGHT_TEST_MATCH === 'responsive-layout.e2e.mjs'
    ? ['responsive-layout.e2e.mjs', 'business-header.e2e.mjs', 'markdown-rendering.e2e.mjs']
    : process.env.PLAYWRIGHT_TEST_MATCH,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    launchOptions: process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : undefined,
  },
  webServer: process.env.PLAYWRIGHT_TEST_MATCH === 'ontology-graph.e2e.mjs' ? undefined : {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    cwd: '..',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
