/**
 * core/usage.ts — usage log: append-only JSONL of every facade operation,
 * plus the pure-code statistics API on top of it.
 *
 * Design: dream.md §4. Baseline capability, not a dream add-on — the dream
 * agent's salience signal ("most queried", "never touched") is only as good
 * as this log, but nothing here depends on dream.
 *
 * Storage: <wikiRoot>/.llm-wiki-ops/usage/YYYY-MM-DD.jsonl — one file per day.
 * Day partitioning gives 1/7/30-day windows for free: read ≤30 files, zero
 * rotation code. Files older than the retention window are pruned lazily.
 *
 * Write path discipline (§4.4):
 *   - Reads are the hot path: buffer in memory, flush fire-and-forget, never
 *     await, never take the wiki lock (that would serialize ms-level reads).
 *   - Writes await the flush: they are already serialized by proper-lockfile,
 *     so one more append is noise-level cost.
 *   - Concurrent appends from multiple processes need no lock: each flush is a
 *     single write call with O_APPEND, atomic for batches under 4KB.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import type { UsageActor, UsageEvent } from "../types.js"

/** Days of history kept; older day-files are pruned on first append of a new day. */
export const USAGE_RETENTION_DAYS = 90

/** Flush threshold — a batch stays well under the 4KB atomic-append limit. */
const FLUSH_BYTES = 3072

/** Max time a buffered read event waits before hitting the disk. */
const FLUSH_INTERVAL_MS = 1000

/** <wikiRoot>/.llm-wiki-ops/usage */
export function usageDir(wikiRoot: string): string {
  return path.join(wikiRoot, ".llm-wiki-ops", "usage")
}

/** <wikiRoot>/.llm-wiki-ops/usage/YYYY-MM-DD.jsonl for a UTC date. */
export function usageFileFor(wikiRoot: string, date: Date = new Date()): string {
  return path.join(usageDir(wikiRoot), `${date.toISOString().slice(0, 10)}.jsonl`)
}

// ── Writer ──────────────────────────────────────────────────────────

/**
 * Buffered appender for one wiki root.
 *
 * One instance per WikiGraph. Errors are swallowed into a counter: a broken
 * usage log must never break a graph operation (it is telemetry, not truth).
 */
export class UsageLogger {
  private buffer: string[] = []
  private bufferedBytes = 0
  private timer: NodeJS.Timeout | null = null
  private flushing: Promise<void> | null = null
  private lastPrunedDay = ""

  /** Count of swallowed write failures — surfaced for diagnostics only. */
  errorCount = 0

  constructor(
    private readonly wikiRoot: string,
    private readonly actor: UsageActor,
  ) {}

  /**
   * Record an event.
   *
   * Hot path (reads): returns immediately, flush happens on a timer or when
   * the buffer fills. Call flush() explicitly on the write path to await it.
   */
  record(event: Omit<UsageEvent, "ts" | "actor">): void {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        op: event.op,
        slug: event.slug,
        actor: this.actor,
        ...(event.dry ? { dry: true as const } : {}),
        ok: event.ok,
        ...(event.err ? { err: event.err } : {}),
      }) + "\n"

    this.buffer.push(line)
    this.bufferedBytes += Buffer.byteLength(line)

    if (this.bufferedBytes >= FLUSH_BYTES) {
      void this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  /**
   * Write buffered lines to today's file.
   *
   * The batch is taken from the buffer BEFORE checking for an in-flight flush,
   * and concurrent flushes chain instead of sharing one promise. Getting this
   * wrong is subtle and silent: the earlier version cleared the timer, saw a
   * flush in flight, and returned that flush's promise while its own lines
   * stayed in the buffer with nothing scheduled to write them — so an awaited
   * flush() could resolve with the caller's events still in memory, which is
   * exactly the durability the write path relies on (§4.4).
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) {
      // Nothing of our own to write, but an earlier batch may still be in the
      // air — await it so callers get a real durability guarantee.
      return this.flushing ?? undefined
    }

    const batch = this.buffer.join("")
    this.buffer = []
    this.bufferedBytes = 0

    const previous = this.flushing ?? Promise.resolve()
    const chained = previous.then(() => this.append(batch))
    this.flushing = chained.finally(() => {
      // Only the newest link clears the marker, so a later flush still chains
      // onto an in-flight one instead of racing it.
      if (this.flushing === chained) this.flushing = null
    })

    return this.flushing
  }

  /** Append one batch; failures are counted, never thrown (telemetry, not truth). */
  private async append(batch: string): Promise<void> {
    const file = usageFileFor(this.wikiRoot)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.appendFile(file, batch, "utf8")
      await this.maybePrune(path.basename(file, ".jsonl"))
    } catch {
      this.errorCount++
    }
  }

  /** Once per day, drop day-files older than the retention window. */
  private async maybePrune(today: string): Promise<void> {
    if (this.lastPrunedDay === today) return
    this.lastPrunedDay = today

    const cutoff = new Date(Date.now() - USAGE_RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10)
    try {
      const dir = usageDir(this.wikiRoot)
      for (const name of await fs.readdir(dir)) {
        if (!name.endsWith(".jsonl")) continue
        if (name.slice(0, 10) < cutoff) {
          await fs.rm(path.join(dir, name), { force: true })
        }
      }
    } catch {
      this.errorCount++
    }
  }
}

// ── Statistics ──────────────────────────────────────────────────────

export interface UsageStatsOptions {
  /** Window size in days (default 30). */
  days?: number
  /** How many most-used nodes to return (default 64). */
  topN?: number
  /** How many least-used nodes to return (default 64). */
  bottomN?: number
  /** Only count events from this actor. */
  actor?: string
  /**
   * Ignore events from this actor. The dream agent excludes its own reads:
   * otherwise every node it inspects scores higher tomorrow, gets picked again,
   * and scores higher still — the same self-feeding loop that made touch use
   * the checked clock instead of updated.
   */
  excludeActor?: string
  /**
   * Full slug universe, so bottom-N can include never-touched nodes.
   * Callers with a resident graph should pass its slugs (avoids a rescan).
   */
  allSlugs?: string[]
}

export interface NodeUsage {
  slug: string
  reads: number
  writes: number
  byActor: Record<string, number>
  /** ISO timestamp of the most recent event; empty for never-touched nodes. */
  lastTs: string
}

export interface UsageStats {
  windowDays: number
  top: NodeUsage[]
  bottom: NodeUsage[]
  totalEvents: number
  /** Events that carried no slug (get_stats, scan_freshness, …). */
  interfaceEvents: number
  /** Day-files actually read. */
  filesRead: number
}

/** Facade ops that mutate the graph — everything else counts as a read. */
const WRITE_OPS = new Set([
  "add_node",
  "update_node",
  "rename_node",
  "delete_node",
  "rebuild_index",
  "add_edge",
  "remove_edge",
  "cleanup",
])

/**
 * Parse cache for immutable day-files (the "expensive operations must be
 * cached" rule). Keyed by path + size + mtime; today's file changes constantly
 * and simply misses on every new append.
 */
const parseCache = new Map<string, UsageEvent[]>()

/** Drop the day-file parse cache (tests, or after external log surgery). */
export function clearUsageCache(): void {
  parseCache.clear()
}

/** UTC day strings for the last `days` days, most recent first. */
function recentDays(days: number): string[] {
  const out: string[] = []
  for (let i = 0; i < days; i++) {
    out.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
  }
  return out
}

async function parseDayFile(file: string): Promise<UsageEvent[]> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(file)
  } catch {
    return [] // no activity that day
  }

  const key = `${file}:${stat.size}:${stat.mtimeMs}`
  const cached = parseCache.get(key)
  if (cached) return cached

  const events: UsageEvent[] = []
  try {
    const raw = await fs.readFile(file, "utf8")
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as UsageEvent)
      } catch {
        // Torn last line from a crashed flush — skip it, keep the rest.
      }
    }
  } catch {
    return []
  }

  parseCache.set(key, events)
  return events
}

/**
 * Aggregate usage over a day window. Pure code, zero LLM.
 *
 * bottom-N deliberately includes never-accessed nodes when `allSlugs` is
 * supplied: "least used" must mean "including the forgotten ones", otherwise
 * the dream agent can never revisit what nobody ever reads.
 */
export async function computeUsageStats(
  wikiRoot: string,
  opts?: UsageStatsOptions,
): Promise<UsageStats> {
  const days = opts?.days ?? 30
  const topN = opts?.topN ?? 64
  const bottomN = opts?.bottomN ?? 64

  const counts = new Map<string, NodeUsage>()
  let totalEvents = 0
  let interfaceEvents = 0
  let filesRead = 0

  const bump = (slug: string, ev: UsageEvent) => {
    let entry = counts.get(slug)
    if (!entry) {
      entry = { slug, reads: 0, writes: 0, byActor: {}, lastTs: "" }
      counts.set(slug, entry)
    }
    if (WRITE_OPS.has(ev.op)) entry.writes++
    else entry.reads++
    entry.byActor[ev.actor] = (entry.byActor[ev.actor] ?? 0) + 1
    if (ev.ts > entry.lastTs) entry.lastTs = ev.ts
  }

  for (const day of recentDays(days)) {
    const events = await parseDayFile(path.join(usageDir(wikiRoot), `${day}.jsonl`))
    if (events.length > 0) filesRead++

    for (const ev of events) {
      if (opts?.actor && ev.actor !== opts.actor) continue
      if (opts?.excludeActor && ev.actor === opts.excludeActor) continue
      totalEvents++
      if (ev.slug === null) {
        interfaceEvents++
        continue
      }
      if (Array.isArray(ev.slug)) {
        for (const s of ev.slug) bump(s, ev)
      } else {
        bump(ev.slug, ev)
      }
    }
  }

  // Join with the slug universe so bottom-N sees never-touched nodes.
  for (const slug of opts?.allSlugs ?? []) {
    if (!counts.has(slug)) {
      counts.set(slug, { slug, reads: 0, writes: 0, byActor: {}, lastTs: "" })
    }
  }

  const total = (u: NodeUsage) => u.reads + u.writes
  const ranked = [...counts.values()].sort(
    (a, b) => total(b) - total(a) || a.slug.localeCompare(b.slug),
  )

  return {
    windowDays: days,
    top: ranked.slice(0, topN),
    bottom: ranked
      .slice()
      .reverse()
      .slice(0, bottomN),
    totalEvents,
    interfaceEvents,
    filesRead,
  }
}
