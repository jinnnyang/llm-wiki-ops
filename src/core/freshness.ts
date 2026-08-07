/**
 * core/freshness.ts — freshness governance: backoff scan for due nodes (pure code, zero LLM).
 *
 * Design doc: docs/design/reason-inference.md §4.5 (指数退避调度)
 *
 * Schedule formula — stateless, recomputed from two dates at any moment:
 *
 *   T (trial duration) = referenceClock − as_of
 *   referenceClock     = checked ?? updated   (§4.3: scheduling looks at the
 *                                              verification clock, falls back to the edit clock)
 *
 *   T < 30 days  → next_interval = 7 days            (每周检查)
 *   otherwise    → next_interval = clamp(T / 12, 7 days, 1095 days)
 *
 *   due when referenceClock + next_interval <= today
 *
 * Edge cases:
 * - as_of missing → T = 0 → weekly. Safe-direction error (§4.5): extra checks
 *   are harmless, missed checks are harmful. Empty as_of is a legal state (§4.4).
 * - status: invalidated → excluded from the scan entirely.
 * - Neither checked nor updated → excluded (nothing to anchor the schedule on).
 * - Emergent property: when a fact changes, as_of is reset → T collapses to 0 →
 *   the node returns to weekly observation automatically (§4.5).
 */

import { scanWiki, type ScannedPage } from "./graph-builder.js"
import type { PageType } from "../types.js"

// ── Constants (all in days) ─────────────────────────────────────────

const WEEK_DAYS = 7
const MONTH_DAYS = 30 // "T < 1 month → weekly" threshold
const CAP_DAYS = 3 * 365 // 3-year upper bound
const DIVISOR = 12 // exponential-backoff divisor

// ── Date helpers (UTC-only; YYYY-MM-DD arithmetic) ──────────────────

function parseDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(ms)) return null
  // Reject rollover like 2026-02-31
  const d = new Date(ms)
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null
  }
  return ms
}

function daysBetween(a: string, b: string): number | null {
  const ma = parseDate(a)
  const mb = parseDate(b)
  if (ma === null || mb === null) return null
  return Math.round((mb - ma) / 86_400_000)
}

function addDays(s: string, days: number): string | null {
  const ms = parseDate(s)
  if (ms === null) return null
  const d = new Date(ms + days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

// ── Public types ────────────────────────────────────────────────────

export interface FreshnessEntry {
  slug: string
  title: string
  type: PageType
  as_of?: string
  /** The clock scheduling actually used: checked if present, else updated. */
  referenceClock: string
  clockSource: "checked" | "updated"
  /** Trial duration in days (referenceClock − as_of); 0 when as_of missing. */
  trialDays: number
  intervalDays: number
  /** YYYY-MM-DD — the day this node became due. */
  nextDue: string
  /** today − nextDue (≥ 0 for due entries). */
  overdueDays: number
}

export interface ScanFreshnessOptions {
  /** Override "today" (YYYY-MM-DD). Defaults to the current UTC date. */
  today?: string
  /** Also return nodes due within this many days (lookahead window). */
  upcomingDays?: number
}

export interface FreshnessScanResult {
  today: string
  totalScanned: number
  skipped: {
    invalidated: number
    noReferenceClock: number
    /** Dream pages, excluded by type (dream.md §7.1). */
    dreams: number
  }
  /** Due now, sorted by overdueDays descending (most overdue first). */
  due: FreshnessEntry[]
  /** Due within upcomingDays, sorted by nextDue ascending. */
  upcoming: FreshnessEntry[]
}

// ── Core computation ────────────────────────────────────────────────

/**
 * Compute the next check interval for one node. Pure function.
 *
 * Returns null when the node has no reference clock or the dates don't parse.
 *
 * @param as_of      Fact clock (may be undefined → treated as fresh fact, weekly).
 * @param checked    Verification clock (may be undefined).
 * @param updated    Edit clock (fallback when checked missing).
 */
export function computeFreshness(
  as_of: string | undefined,
  checked: string | undefined,
  updated: string | undefined,
): { trialDays: number; intervalDays: number; referenceClock: string; clockSource: "checked" | "updated" } | null {
  const referenceClock = checked ?? updated
  const clockSource: "checked" | "updated" = checked !== undefined ? "checked" : "updated"
  if (referenceClock === undefined) return null

  let trialDays: number
  if (as_of === undefined) {
    trialDays = 0
  } else {
    const d = daysBetween(as_of, referenceClock)
    if (d === null) return null // unparseable as_of → skip rather than guess
    trialDays = Math.max(0, d)
  }

  const intervalDays =
    trialDays < MONTH_DAYS
      ? WEEK_DAYS
      : Math.min(CAP_DAYS, Math.max(WEEK_DAYS, Math.floor(trialDays / DIVISOR)))

  return { trialDays, intervalDays, referenceClock, clockSource }
}

/**
 * Scan the whole wiki and return the due list for the check agent.
 * Pure code, zero LLM — the freshness counterpart of purgeByDate.
 */
export async function scanFreshness(
  wikiDir: string,
  wikiRoot: string,
  options?: ScanFreshnessOptions,
): Promise<FreshnessScanResult> {
  const pages = await scanWiki(wikiDir, wikiRoot)
  return scanFreshnessFromPages(pages, options)
}

/**
 * scanFreshness core, operating on an already-scanned page list.
 * Shared by the disk path (scanFreshness) and the resident graph path.
 */
export function scanFreshnessFromPages(
  pages: ScannedPage[],
  options?: ScanFreshnessOptions,
): FreshnessScanResult {
  const opts = options ?? {}
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const todayMs = parseDate(today)
  if (todayMs === null) {
    throw new Error(`scanFreshness: invalid today date "${opts.today}" (expected YYYY-MM-DD)`)
  }

  const due: FreshnessEntry[] = []
  const upcoming: FreshnessEntry[] = []
  let invalidated = 0
  let noReferenceClock = 0
  let dreams = 0

  for (const page of pages) {
    if (page.status === "invalidated") {
      invalidated++
      continue
    }

    // Dream pages are excluded by type (design: dream.md §7.1). They carry no
    // as_of on purpose, and without this skip a missing as_of means T=0 →
    // weekly checks — the most aggressive schedule there is — which would send
    // the check agent off to "verify" a dream and possibly rewrite it.
    if (page.type === "dream") {
      dreams++
      continue
    }

    const fresh = computeFreshness(page.as_of, page.checked, page.updated || undefined)
    if (fresh === null) {
      noReferenceClock++
      continue
    }

    const nextDue = addDays(fresh.referenceClock, fresh.intervalDays)
    if (nextDue === null) {
      noReferenceClock++
      continue
    }

    const overdueDays = daysBetween(nextDue, today)
    if (overdueDays === null) continue

    const entry: FreshnessEntry = {
      slug: page.slug,
      title: page.title,
      type: page.type,
      as_of: page.as_of,
      referenceClock: fresh.referenceClock,
      clockSource: fresh.clockSource,
      trialDays: fresh.trialDays,
      intervalDays: fresh.intervalDays,
      nextDue,
      overdueDays,
    }

    if (overdueDays >= 0) {
      due.push(entry)
    } else if (opts.upcomingDays !== undefined && -overdueDays <= opts.upcomingDays) {
      upcoming.push(entry)
    }
  }

  due.sort((a, b) => b.overdueDays - a.overdueDays)
  upcoming.sort((a, b) => a.nextDue.localeCompare(b.nextDue))

  return {
    today,
    totalScanned: pages.length,
    skipped: { invalidated, noReferenceClock, dreams },
    due,
    upcoming,
  }
}
