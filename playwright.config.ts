import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Use a pre-installed Chromium when the environment provides one (e.g. cloud sandboxes).
const chromium = process.env.RT_CHROMIUM ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    ...(existsSync(chromium) && { launchOptions: { executablePath: chromium } }),
    screenshot: 'only-on-failure',
  },
});
