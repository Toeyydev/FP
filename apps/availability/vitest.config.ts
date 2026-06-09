import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for pure logic (no DB). Run with `npm test`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
