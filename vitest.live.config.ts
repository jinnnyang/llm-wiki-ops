import { defineConfig } from "vitest/config"

/**
 * Live tests: real model, real MCP subprocess, real disk. NOT part of `npm test`.
 *
 * Split into its own config rather than a tag or an env guard inside the normal
 * suite, because these have opposite economics from unit tests: minutes instead
 * of milliseconds, real API spend per run, and outcomes that depend on a model's
 * judgement. Mixing them into `npm test` would make the fast suite unrunnable in
 * a loop, which is the one thing it is for.
 *
 * Run: npm run test:live
 */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    // A dream on a real wiki is minutes, not seconds. Per-test timeouts are set
    // explicitly in the tests too; this is the ceiling.
    testTimeout: 1_200_000,
    hookTimeout: 300_000,
    // Live tests mutate a shared wiki copy and spend real money — one at a time,
    // in declared order. Two dreams on one wiki also fight over the write lock.
    fileParallelism: false,
    sequence: { concurrent: false },
    // Slow by nature; the dot reporter would hide which phase is running.
    reporters: ["verbose"],
  },
})
