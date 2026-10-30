import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  // tests never talk to a real Supabase project, even when .env.local has one
  test: { env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], css: false, include: ['src/**/*.test.{ts,tsx}'] },
});
