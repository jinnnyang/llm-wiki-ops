/**
 * tests/usage.test.ts — usage log writer + statistics (design: dream.md §4).
 *
 * Covers what the dream agent's salience signal actually depends on:
 * event shape on disk, read/write classification, actor attribution,
 * bottom-N including never-touched nodes, and resilience to a torn line
 * from a crashed flush.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import { WikiGraph } from "../src/index.js"
import {
  UsageLogger,
  computeUsageStats,
  clearUsageCache,
  usageDir,
  usageFileFor,
  USAGE_RETENTION_DAYS,
} from "../src/core/usage.js"
import type { UsageEvent } from "../src/types.js"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-usage-"))
  clearUsageCache()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** Read today's log file as parsed events. */
async function readToday(): Promise<UsageEvent[]> {
  const raw = await fs.readFile(usageFileFor(root), "utf8")
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as UsageEvent)
}

/** Write events into an arbitrary day-file, bypassing the logger. */
async function seedDay(day: string, events: Array<Partial<UsageEvent>>): Promise<void> {
  await fs.mkdir(usageDir(root), { recursive: true })
  const lines = events
    .map((e) =>
      JSON.stringify({
        ts: `${day}T12:00:00.000Z`,
        op: "get_node",
        slug: "x",
        actor: "lib",
        ok: true,
        ...e,
      }),
    )
    .join("\n")
  await fs.writeFile(path.join(usageDir(root), `${day}.jsonl`), lines + "\n", "utf8")
}

function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

// ── Writer ──────────────────────────────────────────────────────────

describe("UsageLogger", () => {
  it("writes one JSONL line per event with the documented shape", async () => {
    const logger = new UsageLogger(root, "reason")
    logger.record({ op: "get_node", slug: "alpha", ok: true })
    await logger.flush()

    const events = await readToday()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ op: "get_node", slug: "alpha", actor: "reason", ok: true })
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    expect(events[0].dry).toBeUndefined() // omitted unless true
  })

  it("records edge ops as a two-slug array, and target-less ops as null", async () => {
    const logger = new UsageLogger(root, "cli")
    logger.record({ op: "add_edge", slug: ["a", "b"], ok: true })
    logger.record({ op: "get_stats", slug: null, ok: true })
    await logger.flush()

    const events = await readToday()
    expect(events[0].slug).toEqual(["a", "b"])
    expect(events[1].slug).toBeNull()
  })

  it("keeps dry-run attempts and failures — intent and negative signal both count", async () => {
    const logger = new UsageLogger(root, "dream")
    logger.record({ op: "update_node", slug: "a", dry: true, ok: true })
    logger.record({ op: "delete_node", slug: "b", ok: false, err: "NODE_NOT_FOUND" })
    await logger.flush()

    const events = await readToday()
    expect(events[0].dry).toBe(true)
    expect(events[1]).toMatchObject({ ok: false, err: "NODE_NOT_FOUND" })
  })

  it("appends across flushes instead of truncating", async () => {
    const logger = new UsageLogger(root, "lib")
    logger.record({ op: "get_node", slug: "a", ok: true })
    await logger.flush()
    logger.record({ op: "get_node", slug: "b", ok: true })
    await logger.flush()

    expect(await readToday()).toHaveLength(2)
  })

  it("never throws when the log directory cannot be written", async () => {
    // Point the root at a file, so mkdir of <file>/.llm-wiki-ops fails.
    const filePath = path.join(root, "not-a-dir")
    await fs.writeFile(filePath, "x", "utf8")

    const logger = new UsageLogger(filePath, "lib")
    logger.record({ op: "get_node", slug: "a", ok: true })
    await expect(logger.flush()).resolves.toBeUndefined()
    expect(logger.errorCount).toBe(1)
  })

  it("prunes day-files beyond the retention window", async () => {
    const stale = dayOffset(USAGE_RETENTION_DAYS + 5)
    const recent = dayOffset(1)
    await seedDay(stale, [{}])
    await seedDay(recent, [{}])

    const logger = new UsageLogger(root, "lib")
    logger.record({ op: "get_node", slug: "a", ok: true })
    await logger.flush()

    const remaining = await fs.readdir(usageDir(root))
    expect(remaining).not.toContain(`${stale}.jsonl`)
    expect(remaining).toContain(`${recent}.jsonl`)
  })
})

// ── Statistics ──────────────────────────────────────────────────────

describe("computeUsageStats", () => {
  it("separates reads from writes and tracks the actor breakdown", async () => {
    await seedDay(dayOffset(0), [
      { op: "get_node", slug: "alpha", actor: "reason" },
      { op: "get_node", slug: "alpha", actor: "check" },
      { op: "update_node", slug: "alpha", actor: "check" },
    ])

    const stats = await computeUsageStats(root)
    const alpha = stats.top.find((u) => u.slug === "alpha")!
    expect(alpha.reads).toBe(2)
    expect(alpha.writes).toBe(1)
    expect(alpha.byActor).toEqual({ reason: 1, check: 2 })
    expect(stats.totalEvents).toBe(3)
  })

  it("counts both endpoints of an edge operation", async () => {
    await seedDay(dayOffset(0), [{ op: "add_edge", slug: ["a", "b"] as never }])

    const stats = await computeUsageStats(root)
    expect(stats.top.find((u) => u.slug === "a")!.writes).toBe(1)
    expect(stats.top.find((u) => u.slug === "b")!.writes).toBe(1)
  })

  it("counts target-less events separately, never as node usage", async () => {
    await seedDay(dayOffset(0), [
      { op: "get_stats", slug: null as never },
      { op: "scan_freshness", slug: null as never },
    ])

    const stats = await computeUsageStats(root)
    expect(stats.interfaceEvents).toBe(2)
    expect(stats.top).toHaveLength(0)
  })

  it("bottom-N includes never-touched nodes when the slug universe is given", async () => {
    await seedDay(dayOffset(0), [{ op: "get_node", slug: "hot" }])

    const stats = await computeUsageStats(root, {
      allSlugs: ["hot", "forgotten-1", "forgotten-2"],
    })
    expect(stats.top[0].slug).toBe("hot")

    const bottomSlugs = stats.bottom.map((u) => u.slug)
    expect(bottomSlugs).toContain("forgotten-1")
    expect(bottomSlugs).toContain("forgotten-2")
    expect(stats.bottom[0].reads + stats.bottom[0].writes).toBe(0)
  })

  it("honours the day window and ignores older files", async () => {
    await seedDay(dayOffset(0), [{ slug: "today" }])
    await seedDay(dayOffset(10), [{ slug: "old" }])

    const week = await computeUsageStats(root, { days: 7 })
    expect(week.top.map((u) => u.slug)).toEqual(["today"])

    const month = await computeUsageStats(root, { days: 30 })
    expect(month.top.map((u) => u.slug).sort()).toEqual(["old", "today"])
  })

  it("filters by actor", async () => {
    await seedDay(dayOffset(0), [
      { slug: "a", actor: "dream" },
      { slug: "b", actor: "reason" },
    ])

    const stats = await computeUsageStats(root, { actor: "dream" })
    expect(stats.top.map((u) => u.slug)).toEqual(["a"])
    expect(stats.totalEvents).toBe(1)
  })

  it("respects topN and bottomN limits", async () => {
    await seedDay(
      dayOffset(0),
      Array.from({ length: 10 }, (_, i) => ({ slug: `n${i}` })),
    )

    const stats = await computeUsageStats(root, { topN: 3, bottomN: 2 })
    expect(stats.top).toHaveLength(3)
    expect(stats.bottom).toHaveLength(2)
  })

  it("skips a torn last line from a crashed flush and keeps the rest", async () => {
    await fs.mkdir(usageDir(root), { recursive: true })
    const good = JSON.stringify({
      ts: new Date().toISOString(),
      op: "get_node",
      slug: "alpha",
      actor: "lib",
      ok: true,
    })
    await fs.writeFile(usageFileFor(root), `${good}\n{"ts":"2026-08-0`, "utf8")

    const stats = await computeUsageStats(root)
    expect(stats.totalEvents).toBe(1)
    expect(stats.top[0].slug).toBe("alpha")
  })

  it("returns empty stats when no log exists yet", async () => {
    const stats = await computeUsageStats(root)
    expect(stats).toMatchObject({ totalEvents: 0, filesRead: 0, top: [], bottom: [] })
  })
})

// ── Facade integration ──────────────────────────────────────────────

describe("WikiGraph usage integration", () => {
  it("logs reads and writes with the configured actor", async () => {
    await fs.mkdir(path.join(root, "wiki"), { recursive: true })
    const wiki = new WikiGraph(root, { actor: "dream" })

    await wiki.getStats()
    const added = await wiki.addNode({ title: "Alpha Node", type: "concept" })
    await wiki.getNode(added.slug)
    await wiki.flushUsageLog()

    const events = await readToday()
    const ops = events.map((e) => e.op)
    expect(ops).toContain("get_stats")
    expect(ops).toContain("add_node")
    expect(ops).toContain("get_node")
    expect(events.every((e) => e.actor === "dream")).toBe(true)

    // add_node's slug is only known after the call — it must still be recorded.
    expect(events.find((e) => e.op === "add_node")!.slug).toBe(added.slug)
  })

  it("writes nothing when maintainLog is false", async () => {
    await fs.mkdir(path.join(root, "wiki"), { recursive: true })
    const wiki = new WikiGraph(root, { maintainLog: false })

    await wiki.getStats()
    await wiki.flushUsageLog()

    await expect(fs.access(usageDir(root))).rejects.toThrow()
  })

  it("records a failed operation with its error code", async () => {
    await fs.mkdir(path.join(root, "wiki"), { recursive: true })
    const wiki = new WikiGraph(root, { actor: "cli" })

    await expect(wiki.updateNode("does-not-exist", { content: "x" })).rejects.toThrow()
    await wiki.flushUsageLog()

    const failed = (await readToday()).find((e) => e.op === "update_node")!
    expect(failed.ok).toBe(false)
    expect(failed.err).toBeTruthy()
  })

  it("normalizes wikiRoot so case variants resolve to one canonical root", () => {
    const a = new WikiGraph(root, { maintainLog: false })
    const b = new WikiGraph(root.toUpperCase(), { maintainLog: false })
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(b.wikiRoot).toBe(a.wikiRoot)
    } else {
      expect(b.wikiRoot).not.toBe(a.wikiRoot) // case-sensitive FS
    }
  })
})
