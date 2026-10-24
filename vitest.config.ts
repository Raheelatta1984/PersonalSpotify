import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    reporters: ["default"],
    pool: "threads",
    // CI runners are smaller; keep parallelism bounded so audio tests stay stable.
    maxWorkers: process.env.CI ? 4 : undefined,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
