/**
 * Freshness governance: computeFreshness (pure) + scanFreshness (wiki scan).
 * Design doc: docs/design/reason-inference.md §4.5
 *
 *   T = referenceClock − as_of
 *   T < 30d  → weekly (7d)
 *   else     → clamp(T/12, 7d, 1095d)
 *   referenceClock = checked ?? updated
 */
import { describe, it, expect } from "vitest"
import { computeFreshness } from "../src/core/freshness.js"
import { WikiGraph } from "../src/index.js"
import { createFixtureWiki, type FixtureWiki } from "./helpers.js"
import * as fs from "node:fs/promises"
import * as path from "node:path"

describe("computeFreshness", () => {
  it("T < 1 month → weekly", () => {
    // as_of 2025-06-01, checked 2025-06-15 → T = 14d < 30 → 7d
    const r = computeFreshness("2025-06-01", "2025-06-15", undefined)!
    expect(r.trialDays).toBe(14)
    expect(r.intervalDays).toBe(7)
    expect(r.clockSource).toBe("checked")
  })

  it("as_of missing → treated as fresh fact, weekly", () => {
    const r = computeFreshness(undefined, "2025-06-15", undefined)!
    expect(r.trialDays).toBe(0)
    expect(r.intervalDays).toBe(7)
  })

  it("long trial → T/12 backoff", () => {
    // as_of 2023-01-01, checked 2025-06-15 → T = 896d (365+366+165) → floor(896/12) = 74d
    const r = computeFreshness("2023-01-01", "2025-06-15", undefined)!
    expect(r.trialDays).toBe(896)
    expect(r.intervalDays).toBe(Math.floor(896 / 12))
  })

  it("interval capped at 3 years", () => {
    // T ≈ 5000d → T/12 ≈ 416 > 1095? no; use T ≈ 40 years → floor(T/12) > 1095
    const r = computeFreshness("1985-01-01", "2025-01-01", undefined)!
    expect(r.intervalDays).toBe(1095)
  })

  it("falls back to updated when checked missing", () => {
    const r = computeFreshness("2025-06-01", undefined, "2025-06-15")!
    expect(r.clockSource).toBe("updated")
    expect(r.referenceClock).toBe("2025-06-15")
  })

  it("checked takes priority over updated", () => {
    const r = computeFreshness("2025-06-01", "2025-07-01", "2025-06-15")!
    expect(r.clockSource).toBe("checked")
    expect(r.referenceClock).toBe("2025-07-01")
  })

  it("no reference clock at all → null", () => {
    expect(computeFreshness("2025-06-01", undefined, undefined)).toBeNull()
    expect(computeFreshness(undefined, undefined, undefined)).toBeNull()
  })

  it("unparseable as_of → null (skip, don't guess)", () => {
    expect(computeFreshness("not-a-date", "2025-06-15", undefined)).toBeNull()
  })

  it("as_of in the future of reference clock → T clamped to 0", () => {
    const r = computeFreshness("2025-06-30", "2025-06-15", undefined)!
    expect(r.trialDays).toBe(0)
    expect(r.intervalDays).toBe(7)
  })
})

describe("scanFreshness (wiki-level)", () => {
  async function makeFreshnessFixture(): Promise<FixtureWiki> {
    const root = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "llm-wiki-fresh-"))
    const wikiDir = path.join(root, "wiki")
    await fs.mkdir(path.join(wikiDir, "concepts"), { recursive: true })

    const pages: Array<{ file: string; content: string }> = [
      {
        // checked 2025-01-01, as_of 2020-01-01 → T ≈ 1827d → interval min(152d, 1095) = 152
        // nextDue = 2025-06-02 → overdue at today 2026-05-15
        file: "old-fact.md",
        content: `---
type: concept
title: "Old Fact"
created: "2020-01-01"
updated: "2024-12-01"
as_of: "2020-01-01"
checked: "2025-01-01"
---

# Old Fact
`,
      },
      {
        // checked 2026-05-01 → interval 7d → nextDue 2026-05-08 → not due yet on 2026-05-15? 
        // 2026-05-08 < 2026-05-15 → actually due! Use checked 2026-05-14 → nextDue 2026-05-21 → upcoming only.
        file: "recent-fact.md",
        content: `---
type: concept
title: "Recent Fact"
created: "2026-01-01"
updated: "2026-04-01"
as_of: "2026-01-01"
checked: "2026-05-14"
---

# Recent Fact
`,
      },
      {
        file: "dead-fact.md",
        content: `---
type: concept
title: "Dead Fact"
created: "2020-01-01"
updated: "2020-01-01"
status: invalidated
---

# Dead Fact
`,
      },
      {
        // no checked/updated → excluded
        file: "no-clock.md",
        content: `---
type: concept
title: "No Clock"
created: "2020-01-01"
---

# No Clock
`,
      },
    ]

    for (const page of pages) {
      await fs.writeFile(path.join(wikiDir, "concepts", page.file), page.content, "utf-8")
    }

    return {
      root,
      wikiDir,
      cleanup: async () => {
        await fs.rm(root, { recursive: true, force: true })
      },
    }
  }

  it("classifies due / upcoming / skipped correctly", async () => {
    const fixture = await makeFreshnessFixture()
    try {
      const wiki = new WikiGraph(fixture.root, { maintainLog: false })
      const result = await wiki.scanFreshness({ today: "2026-05-15", upcomingDays: 30 })

      expect(result.totalScanned).toBe(4)
      expect(result.skipped.invalidated).toBe(1)
      expect(result.skipped.noReferenceClock).toBe(1)

      // old-fact is overdue
      const dueSlugs = result.due.map((e) => e.slug)
      expect(dueSlugs).toContain("old-fact")
      expect(dueSlugs).not.toContain("dead-fact") // invalidated excluded
      expect(dueSlugs).not.toContain("no-clock") // no reference clock

      // recent-fact: nextDue 2026-05-21 → within upcomingDays=30
      const upcomingSlugs = result.upcoming.map((e) => e.slug)
      expect(upcomingSlugs).toContain("recent-fact")

      // old-fact entry details
      const old = result.due.find((e) => e.slug === "old-fact")!
      expect(old.clockSource).toBe("checked")
      expect(old.referenceClock).toBe("2025-01-01")
      expect(old.overdueDays).toBeGreaterThan(0)
    } finally {
      await fixture.cleanup()
    }
  })

  it("throws on invalid today date", async () => {
    const fixture = await makeFreshnessFixture()
    try {
      const wiki = new WikiGraph(fixture.root, { maintainLog: false })
      await expect(wiki.scanFreshness({ today: "not-a-date" })).rejects.toThrow(/invalid today/)
    } finally {
      await fixture.cleanup()
    }
  })
})
