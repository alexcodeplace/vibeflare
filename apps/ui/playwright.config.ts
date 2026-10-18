import { defineConfig, devices } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

const port = process.env.VF_E2E_PORT ?? '8788';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 45_000,
  retries: 0,
  reporter: 'list',
  fullyParallel: false,
  workers: 1, // E2E uses one deterministic local D1/R2/DO fixture namespace.
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    screenshot: "only-on-failure",
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'bash scripts/start-e2e.sh',
    url: `http://localhost:${port}/health`,
    reuseExistingServer: !process.env.CI && !process.env.VF_E2E_PORT,
    timeout: 180_000,
  },
});
