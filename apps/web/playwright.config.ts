import { defineConfig } from '@playwright/test';

// Optional smoke test: `npm run dev` in the repo root (demo mode), then `npm run e2e -w @solar/web`.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:5173', trace: 'on-first-retry' },
  reporter: [['list']],
});
