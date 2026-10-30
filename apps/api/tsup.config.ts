import { defineConfig } from 'tsup';

// Bundle the workspace package so the built server runs without the monorepo's TypeScript sources.
export default defineConfig({
  entry: ['src/server.ts', 'src/vercel.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  outDir: 'dist',
  noExternal: ['@solar/shared'],
});
