import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: 'work/qa/browser-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: '**/mobile.spec.mjs', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testIgnore: '**/mobile.spec.mjs', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-phone', testMatch: '**/mobile.spec.mjs', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
