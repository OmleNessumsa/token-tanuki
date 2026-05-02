import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/analysis/**/*.ts", "src/chain.ts"],
      exclude: [
        "src/cli.ts",
        "src/clients/**",
        "src/analyze.ts",
        "src/format.ts",
        "src/http.ts",
        "src/config.ts",
        "src/schemas.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
