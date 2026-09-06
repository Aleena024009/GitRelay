import { defineConfig } from 'vitest/config'

// The app's Vite config carries the PWA plugin and the CSP injector, neither
// of which should run for unit tests, so tests get their own minimal config.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
})
