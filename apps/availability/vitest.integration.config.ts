import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integration tests: these talk to a REAL Postgres, because the bugs they exist to
// catch are invisible to pure-function tests. A Prisma `where` clause cannot be
// unit-tested — `NOT: { col: "x" }` silently dropping NULL rows type-checks, passes
// every unit test, and returns an empty page in production.
//
// Run with `npm run test:integration` and a DATABASE_URL pointing at a THROWAWAY
// database — every test truncates. CI provides one; locally, create one first.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.itest.ts"],
    // One DB, so tests must not race each other over the same tables.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
