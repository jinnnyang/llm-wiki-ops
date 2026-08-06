/**
 * Conclusion-round skip decision: the deliverable is in hand when the run
 * completed naturally and the final assistant message is substantial.
 * Misjudging only costs one extra rescue round — it never loses the report.
 */
import { describe, it, expect } from "vitest"
import { shouldSkipConclusion } from "../src/agent/loop.js"

const REPORT = "x".repeat(800) // well above the 500-char default
const THIN = "Analysis done."

describe("shouldSkipConclusion", () => {
  it("skips when deliverable present and run completed", () => {
    expect(shouldSkipConclusion("completed", REPORT, { skipIfDeliverable: true })).toBe(true)
  })

  it("never skips without skipIfDeliverable opt-in", () => {
    expect(shouldSkipConclusion("completed", REPORT, undefined)).toBe(false)
    expect(shouldSkipConclusion("completed", REPORT, {})).toBe(false)
  })

  it("never skips when final message is below threshold", () => {
    expect(shouldSkipConclusion("completed", THIN, { skipIfDeliverable: true })).toBe(false)
    expect(shouldSkipConclusion("completed", "", { skipIfDeliverable: true })).toBe(false)
  })

  it("never skips for non-completed statuses", () => {
    for (const status of ["max_iterations", "error", "timeout", "aborted"] as const) {
      expect(shouldSkipConclusion(status, REPORT, { skipIfDeliverable: true })).toBe(false)
    }
  })

  it("honours custom deliverableMinChars", () => {
    expect(shouldSkipConclusion("completed", THIN, { skipIfDeliverable: true, deliverableMinChars: 5 })).toBe(true)
    expect(shouldSkipConclusion("completed", REPORT, { skipIfDeliverable: true, deliverableMinChars: 2000 })).toBe(false)
  })

  it("boundary: exactly at threshold counts as deliverable", () => {
    const exact = "x".repeat(500)
    expect(shouldSkipConclusion("completed", exact, { skipIfDeliverable: true })).toBe(true)
    expect(shouldSkipConclusion("completed", exact.slice(0, -1), { skipIfDeliverable: true })).toBe(false)
  })
})
