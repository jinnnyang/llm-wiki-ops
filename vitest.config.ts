import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Live tests (real model, real API spend, minutes per run) live under
    // tests/live/ and are NOT part of `npm test`. Excluded by path rather than by
    // an env guard inside the files, so the fast suite stays a clean pass instead
    // of reporting a pile of skips.
    exclude: ["tests/live/**"],
    testTimeout: 30_000,
  },
})
