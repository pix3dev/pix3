import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts', 'packages/pix3-runtime/src/**/*.spec.ts'],
    // The default 'forks' pool reports "No test suite found" for every spec on
    // win32-arm64 (vitest 4.x); the threads pool runs them fine everywhere.
    pool: 'threads',
    // Uncapped, one worker per core exhausts memory on high-core machines and every
    // file fails with the same "No test suite found" error. Four is plenty: the run
    // is import/environment-bound, not test-bound.
    maxWorkers: 4,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/components': resolve(__dirname, 'src/components'),
      '@/core': resolve(__dirname, 'src/core'),
      '@/plugins': resolve(__dirname, 'src/plugins'),
      '@/rendering': resolve(__dirname, 'src/rendering'),
      '@/services': resolve(__dirname, 'src/services'),
      '@/state': resolve(__dirname, 'src/state'),
      '@/styles': resolve(__dirname, 'src/styles'),
      '@/fw': resolve(__dirname, 'src/fw'),
      '@pix3/runtime': resolve(__dirname, 'packages/pix3-runtime/src'),
    },
  },
});
