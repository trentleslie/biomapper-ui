import { defineConfig } from "vitest/config";
import path from "path";

// Standalone config: vite.config.ts requires PORT and BASE_PATH, which tests do not need.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
