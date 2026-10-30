import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Suítes de integração compartilham o mesmo banco de testes.
    fileParallelism: false,
  },
});
