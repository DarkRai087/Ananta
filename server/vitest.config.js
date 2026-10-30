import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    env: { DB_PATH: ":memory:", LAB_PROVIDER: "yahoo" },
    testTimeout: 30_000,
  },
});
