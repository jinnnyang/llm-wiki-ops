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
  sliceForAtomicAppend,
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

  it("does not drop a batch recorded while another flush is in flight", async () => {
    // Regression: flush() cleared the timer, saw an in-flight flush, and
    // returned THAT promise while its own lines stayed in the buffer with
    // nothing scheduled to write them — so an awaited flush() resolved with the
    // caller's events still in memory. The write path's durability depends on
    // this not happening (§4.4).
    const logger = new UsageLogger(root, "lib")
    logger.record({ op: "get_node", slug: "a", ok: true })
    const first = logger.flush()
    logger.record({ op: "get_node", slug: "b", ok: true })
    const second = logger.flush()
    await Promise.all([first, second])

    const slugs = (await readToday()).map((e) => e.slug)
    expect(slugs).toContain("a")
    expect(slugs).toContain("b")
  })

  it("flush() with an empty buffer still awaits an in-flight batch", async () => {
    const logger = new UsageLogger(root, "lib")
    logger.record({ op: "get_node", slug: "a", ok: true })
    const inFlight = logger.flush()
    await logger.flush() // buffer empty, but must not resolve before the batch lands
    await inFlight
    expect((await readToday()).map((e) => e.slug)).toContain("a")
  })

  it("keeps every event across many interleaved flushes", async () => {
    const logger = new UsageLogger(root, "lib")
    const pending: Promise<void>[] = []
    for (let i = 0; i < 30; i++) {
      logger.record({ op: "get_node", slug: `n${i}`, ok: true })
      pending.push(logger.flush())
    }
    await Promise.all(pending)
    await logger.flush()

    const slugs = (await readToday()).map((e) => e.slug)
    expect(new Set(slugs).size).toBe(30)
  })

  it("clears the in-flight marker once settled, so the chain can be collected", async () => {
    // Regression: the marker held `chained.finally(...)`'s RETURN value while the
    // callback compared against `chained` itself — never equal, so the marker was
    // never cleared and the promise chain grew for the life of the process. The
    // comment claimed "only the newest link clears the marker"; it never ran.
    const logger = new UsageLogger(root, "lib")
    logger.record({ op: "get_node", slug: "a", ok: true })
    await logger.flush()
    expect((logger as unknown as { flushing: Promise<void> | null }).flushing).toBeNull()

    // Still null after a chained pair.
    logger.record({ op: "get_node", slug: "b", ok: true })
    const first = logger.flush()
    logger.record({ op: "get_node", slug: "c", ok: true })
    await Promise.all([first, logger.flush()])
    expect((logger as unknown as { flushing: Promise<void> | null }).flushing).toBeNull()
  })

  it("truncates a huge err so one event can never exceed an append slice", async () => {
    const logger = new UsageLogger(root, "lib")
    logger.record({ op: "update_node", slug: "x", ok: false, err: "E".repeat(9000) })
    await logger.flush()

    const event = (await readToday())[0]
    expect(event.err!.length).toBeLessThanOrEqual(200)
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

describe("sliceForAtomicAppend", () => {
  const line = (i: number) =>
    JSON.stringify({ ts: "2026-08-08T00:00:00.000Z", op: "get_node", slug: `n${i}`, actor: "lib", ok: true })

  it("passes a small batch through untouched", () => {
    const batch = line(1) + "\n"
    expect(sliceForAtomicAppend(batch)).toEqual([batch])
  })

  it("caps every slice at the atomic-append size", () => {
    // FLUSH_BYTES is only a trigger, not a ceiling: the last event can push a
    // batch past it, and an explicit flush() writes whatever is buffered. Without
    // slicing, a concurrent process could interleave mid-line and the torn line
    // would be silently skipped on read — silent data loss.
    const batch = Array.from({ length: 2000 }, (_, i) => line(i)).join("\n") + "\n"
    expect(Buffer.byteLength(batch)).toBeGreaterThan(4096)

    const slices = sliceForAtomicAppend(batch)
    expect(slices.length).toBeGreaterThan(1)
    for (const slice of slices) {
      expect(Buffer.byteLength(slice)).toBeLessThanOrEqual(4096)
    }
  })

  it("loses nothing and always cuts on a line boundary", () => {
    const batch = Array.from({ length: 500 }, (_, i) => line(i)).join("\n") + "\n"
    const slices = sliceForAtomicAppend(batch)

    expect(slices.join("")).toBe(batch) // byte-for-byte
    for (const slice of slices) {
      expect(slice.endsWith("\n")).toBe(true)
      for (const l of slice.split("\n").filter(Boolean)) {
        expect(() => JSON.parse(l)).not.toThrow() // no half lines
      }
    }
  })

  it("emits an oversized single line alone rather than cutting it", () => {
    const huge = JSON.stringify({ op: "x", pad: "P".repeat(9000) })
    const slices = sliceForAtomicAppend(`${huge}\n${line(1)}\n`)
    expect(slices[0]).toBe(`${huge}\n`) // intact, not split mid-line
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

  it("excludes one actor's events on request (dream's own reads)", async () => {
    // Without this the dream inflates tomorrow's salience for every node it
    // read today — pick it, read it, score it higher, pick it again.
    await seedDay(dayOffset(0), [
      { slug: "a", actor: "dream" },
      { slug: "a", actor: "reason" },
      { slug: "b", actor: "dream" },
    ])

    const stats = await computeUsageStats(root, { excludeActor: "dream" })
    expect(stats.totalEvents).toBe(1)
    expect(stats.top.map((u) => u.slug)).toEqual(["a"])
    expect(stats.top[0].byActor).toEqual({ reason: 1 })
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

  it("keeps wikiRoot's real casing and canonicalizes only the cache key", () => {
    // The real path must never be mangled: macOS can be case-sensitive (APFS),
    // where lowercasing would break file access outright. Identity/cache
    // collapsing happens on cacheKey instead.
    const a = new WikiGraph(root, { maintainLog: false })
    const b = new WikiGraph(root.toUpperCase(), { maintainLog: false })

    expect(a.wikiRoot).toBe(path.resolve(root))
    expect(b.wikiRoot).toBe(path.resolve(root.toUpperCase())) // untouched casing

    if (process.platform === "win32") {
      expect(b.cacheKey).toBe(a.cacheKey) // one physical dir → one cache entry
    } else {
      expect(b.cacheKey).not.toBe(a.cacheKey) // case-sensitive FS: different paths
    }
  })

  it("listSlugs enumerates past readGraph's 200/500 limits", async () => {
    // Regression: usage_stats collected allSlugs via readGraph(), which throws
    // ResultTooLargeError above 200 nodes — so `graph usage` and the MCP
    // usage_stats tool failed on every real wiki, including the dream agent's
    // "what has been forgotten" signal.
    await fs.mkdir(path.join(root, "wiki", "concepts"), { recursive: true })
    for (let i = 0; i < 210; i++) {
      await fs.writeFile(
        path.join(root, "wiki", "concepts", `n${i}.md`),
        `---\ntitle: N${i}\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nBody.\n`,
        "utf8",
      )
    }

    const wiki = new WikiGraph(root, { maintainLog: false })
    const slugs = await wiki.listSlugs()
    expect(slugs.length).toBe(210)

    // readGraph still (correctly) refuses — that's why listSlugs exists.
    await expect(wiki.readGraph()).rejects.toThrow()

    // And the full usage_stats path works on a wiki this size.
    const stats = await computeUsageStats(root, { allSlugs: slugs, bottomN: 5 })
    expect(stats.bottom).toHaveLength(5)
  })

  it("reads the compression stage back — the forgetting loop must be closed", async () => {
    // Regression: compression was write-only (UpdateNodePatch + node-ops wrote
    // it, nothing read it), so "at most one level down per dream" and "only
    // delete a skeleton" were both unobservable and unenforceable.
    await fs.mkdir(path.join(root, "wiki", "concepts"), { recursive: true })
    await fs.writeFile(
      path.join(root, "wiki", "concepts", "x.md"),
      `---\ntitle: X\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\ncompression: skeleton\n---\n\nShort.\n`,
      "utf8",
    )

    const wiki = new WikiGraph(root, { maintainLog: false })
    expect((await wiki.getNode("x"))?.compression).toBe("skeleton")

    const graph = await wiki.readGraph()
    expect(graph.nodes.find((n) => n.slug === "x")?.compression).toBe("skeleton")

    // Round-trip through update_node too.
    await wiki.updateNode("x", { compression: "condensed" })
    expect((await wiki.getNode("x"))?.compression).toBe("condensed")
  })
})
