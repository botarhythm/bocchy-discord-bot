import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,          // Jest 互換 (describe,it,expect を global へ)
    environment: 'node',    // Discord Bot は DOM 不要
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['dist/**', 'node_modules/**', 'test/**'],
    },
    exclude: ['test/**', 'dist/**', 'node_modules/**'],
  },
}); 