import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: {
      DATABASE_URL: "file:./test.db",
      JWT_SECRET: "test-secret-do-not-use-in-production",
      CORS_ORIGIN: "http://localhost:3000",
      NODE_ENV: "test",
    },
    // All test files share one SQLite database; run them serially to avoid write locks.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 60_000,
  },
})
