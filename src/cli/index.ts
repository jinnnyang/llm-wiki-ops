#!/usr/bin/env node
/**
 * cli/index.ts — llm-wiki main CLI entry point.
 *
 * Design doc: §5
 *
 * Binary names: llm-wiki (primary), llm-wiki-ops (alias, backward compat)
 *
 * Command structure:
 *   llm-wiki new <name> [--path <dir>]     — initialize a new wiki
 *   llm-wiki graph <subcommand>            — 12 low-level graph operations
 *   llm-wiki ingest|research|purge|check|reason  — high-level agent commands (Phase 2+)
 */

import { Command } from "commander"
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { resolve, join } from "node:path"
import { createGraphCommand } from "./graph.js"
import { runIngest, runDirectoryIngest } from "../agent/ingest.js"
import { resolveTarget, isValidWiki, getWikisRoot, listValidWikis } from "./wiki-resolve.js"

const program = new Command()

program
  .name("llm-wiki")
  .description("LLM-powered wiki operations — graph management + intelligent agents")
  .version("0.2.0")

// ── graph subcommand (existing 12 operations) ────────────────────────

program.addCommand(createGraphCommand())

// ── Agent timeout guidance (--help only) ─────────────────────────────
// The four task tiers (fast/medium/max/ultra) are advisory guidance for
// callers — deliberately NOT a CLI option or code concept. Agents respond
// differently to task scale, so help text steers callers to set --timeout
// proactively instead of relying on the 10-min default.

function timeoutGuidance(tiers: string): string {
  return (
    "\nTimeout guidance — agent runtime scales with task size, and each\n" +
    "agent responds differently to the four task tiers below. Set --timeout\n" +
    "proactively based on the expected workload (default: 10 min, fits 'max').\n\n" +
    tiers
  )
}

// ── use — set/clear SELECTED_WIKI ────────────────────────────────────

program
  .command("use [wiki]")
  .description("Set the default wiki target (prints shell command to eval)")
  .action((wiki: string | undefined) => {
    // Clear: llm-wiki use / | llm-wiki use '' | llm-wiki use
    if (!wiki || wiki === "/" || wiki === "") {
      console.error("# Clear SELECTED_WIKI")
      console.log('$env:SELECTED_WIKI = ""')
      return
    }

    // Validate: if it looks like a slug, WIKIS_ROOT must be valid
    const wikisRoot = getWikisRoot()
    const isSlug = !wiki.includes("/") && !wiki.includes("\\") && !wiki.includes(":")

    if (isSlug) {
      if (!wikisRoot) {
        console.error(
          `Error: "${wiki}" looks like a slug, but WIKIS_ROOT is not set or invalid.\n` +
          "  Set WIKIS_ROOT first, or use a full path.",
        )
        process.exit(1)
      }
      const resolved = join(wikisRoot, wiki)
      if (!isValidWiki(resolved)) {
        console.error(
          `Error: "${wiki}" → "${resolved}" is not a valid wiki.\n` +
          "  A valid wiki must have wiki/, raw/, and wiki/index.md.",
        )
        process.exit(1)
      }
    } else {
      // Full path — validate it
      const resolved = resolve(wiki)
      if (!isValidWiki(resolved)) {
        console.error(
          `Error: "${resolved}" is not a valid wiki.\n` +
          "  A valid wiki must have wiki/, raw/, and wiki/index.md.",
        )
        process.exit(1)
      }
    }

    // stdout: eval-able command only. stderr: human hints.
    console.error(`# Set SELECTED_WIKI to "${wiki}"`)
    console.log(`$env:SELECTED_WIKI = "${wiki}"`)
  })

// ── status — show current wiki configuration ────────────────────────

program
  .command("status")
  .description("Show current wiki resolution configuration")
  .option("--json", "machine-readable JSON output")
  .action((opts: Record<string, unknown>) => {
    const wikisRoot = getWikisRoot()
    const selected = process.env.SELECTED_WIKI || null
    const wikis = wikisRoot ? listValidWikis(wikisRoot) : []

    const info = {
      WIKIS_ROOT: wikisRoot ?? "(not set or invalid)",
      SELECTED_WIKI: selected ?? "(not set)",
      validWikis: wikis.map((w) => w.split(/[\\/]/).pop()),
      totalValidWikis: wikis.length,
    }

    if (opts.json) {
      console.log(JSON.stringify(info, null, 2))
    } else {
      console.log(`WIKIS_ROOT:      ${info.WIKIS_ROOT}`)
      console.log(`SELECTED_WIKI:   ${info.SELECTED_WIKI}`)
      console.log(`Valid wikis (${info.totalValidWikis}):`)
      for (const w of info.validWikis) {
        const marker = w === selected ? " ← selected" : ""
        console.log(`  - ${w}${marker}`)
      }
      if (!selected && wikis.length > 0) {
        console.log(`\nMode: global search (read-only across all wikis)`)
        console.log(`  Write operations require: llm-wiki use <wiki> or --wiki <path>`)
      }
    }
  })

// ── new — wiki initialization ────────────────────────────────────────

program
  .command("new <name>")
  .description("Initialize a new wiki with minimal structure")
  .option("--path <dir>", "parent directory (default: current directory)")
  .action((name: string, opts: Record<string, unknown>) => {
    const parentDir = resolve((opts.path as string) ?? ".")
    const wikiRoot = join(parentDir, name)
    const wikiDir = join(wikiRoot, "wiki")

    // Guard: target exists and is non-empty
    if (existsSync(wikiRoot)) {
      const entries = readdirSync(wikiRoot)
      if (entries.length > 0) {
        console.error(`Error: "${wikiRoot}" already exists and is not empty.`)
        process.exit(1)
      }
    }

    // Create structure
    mkdirSync(wikiDir, { recursive: true })

    const today = new Date().toISOString().slice(0, 10)

    // index.md — category index skeleton
    writeFileSync(
      join(wikiDir, "index.md"),
      `# ${name} — Index

## Entities

## Concepts

## Sources

## Queries

## Comparisons

## Synthesis
`,
      "utf-8",
    )

    // log.md — research log
    writeFileSync(
      join(wikiDir, "log.md"),
      `# Research Log

## ${today}

- Wiki initialized via \`llm-wiki new ${name}\`
`,
      "utf-8",
    )

    // overview.md — overview page with frontmatter
    writeFileSync(
      join(wikiDir, "overview.md"),
      `---
title: "${name} Overview"
type: overview
created: ${today}
updated: ${today}
tags: []
---

# ${name} Overview

This wiki was initialized on ${today}. Add content with \`llm-wiki ingest\` or \`llm-wiki graph add-node\`.
`,
      "utf-8",
    )

    console.log(`Created wiki at ${wikiRoot}`)
    console.log(`  wiki/index.md    — category index`)
    console.log(`  wiki/log.md      — research log`)
    console.log(`  wiki/overview.md — overview page`)
    console.log(`\nNext: llm-wiki ingest ./doc.md --wiki ${wikiRoot}`)
  })

// ── ingest — document/directory ingestion agent ─────────────────────

program
  .command("ingest <path>")
  .description("Ingest a document or directory (MD/TXT/HTML/MMD/RMD) into the wiki via LLM agent")
  .option("--wiki <path>", "wiki root directory")
  .option("--json", "machine-readable JSON output")
  .option("--max-iterations <n>", "max agent loop iterations (default 30)")
  .option("--timeout <minutes>", "timeout in minutes (default 10)")
  .option("--verbose", "print tool call logs to stderr")
  .option("--dry-run", "preview operations without writing")
  .addHelpText("after", timeoutGuidance(
    "  fast      single small document              --timeout 2\n" +
    "  medium    several documents / one topic      --timeout 5\n" +
    "  max       a directory of documents           --timeout 10 (default)\n" +
    "  ultra     large batch, deep extraction       --timeout 20+\n\n" +
    "Note: for directory ingest the timeout applies PER FILE. Rough guidance,\n" +
    "not hard rules — use --verbose to watch progress and adjust.",
  ))
  .action(async (inputPath: string, opts: Record<string, unknown>) => {
    const target = resolveTarget(opts.wiki as string | undefined, true)
    const wikiRoot = target.paths[0]

    const resolved = resolve(inputPath)
    if (!existsSync(resolved)) {
      console.error(`Error: path not found: ${resolved}`)
      process.exit(1)
    }

    const maxIterations = opts.maxIterations ? parseInt(opts.maxIterations as string, 10) : undefined
    const timeoutMs = opts.timeout ? parseInt(opts.timeout as string, 10) * 60_000 : undefined

    try {
      const isDir = statSync(resolved).isDirectory()

      if (isDir) {
        // ── Directory ingest ──
        const dirResult = await runDirectoryIngest({
          srcDir: resolved,
          wikiRoot,
          maxIterations,
          timeoutMs,
          verbose: !!opts.verbose,
          dryRun: !!opts.dryRun,
        })

        if (opts.json) {
          console.log(JSON.stringify({
            mode: "directory",
            copied: dirResult.copied.length,
            succeeded: dirResult.succeeded,
            failed: dirResult.failed,
            results: dirResult.results.map((r) => ({
              file: r.file,
              status: r.result?.status,
              error: r.error ?? r.result?.error,
              iterations: r.result?.iterations,
            })),
          }, null, 2))
        } else {
          console.log(`\n── Directory Ingest ${"─".repeat(44)}`)
          console.log(`  Source: ${resolved}`)
          console.log(`  Copied: ${dirResult.copied.length} files → raw/sources/`)
          console.log(`  Ingested: ${dirResult.succeeded} succeeded, ${dirResult.failed} failed`)
        }

        if (dirResult.failed > 0 && dirResult.succeeded === 0) {
          process.exit(1)
        }
      } else {
        // ── Single file ingest ──
        if (opts.verbose) {
          console.error(`[ingest] file: ${resolved}`)
          console.error(`[ingest] wiki: ${wikiRoot}`)
        }

        const result = await runIngest({
          filePath: resolved,
          wikiRoot,
          maxIterations,
          timeoutMs,
          verbose: !!opts.verbose,
          dryRun: !!opts.dryRun,
        })

        printAgentResult(result, opts)
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ── research — wiki research agent ──────────────────────────────────

program
  .command("research <query>")
  .description("Research and enrich wiki content via LLM agent")
  .option("--wiki <path>", "wiki root directory")
  .option("--json", "machine-readable JSON output")
  .option("--max-iterations <n>", "max agent loop iterations (default 30)")
  .option("--timeout <minutes>", "timeout in minutes (default 10)")
  .option("--verbose", "print tool call logs to stderr")
  .option("--dry-run", "preview operations without writing")
  .addHelpText("after", timeoutGuidance(
    "  fast      single-node fact lookup            --timeout 2\n" +
    "  medium    enrich one topic                   --timeout 5\n" +
    "  max       multi-node research sweep          --timeout 10 (default)\n" +
    "  ultra     broad enrichment across the wiki   --timeout 20+\n\n" +
    "Rough guidance, not hard rules — use --verbose to watch progress and adjust.",
  ))
  .action(async (query: string, opts: Record<string, unknown>) => {
    const target = resolveTarget(opts.wiki as string | undefined, true)
    const wikiRoot = target.paths[0]
    const { runResearch } = await import("../agent/research.js")
    try {
      const result = await runResearch({
        wikiRoot,
        query,
        maxIterations: opts.maxIterations ? parseInt(opts.maxIterations as string, 10) : undefined,
        timeoutMs: opts.timeout ? parseInt(opts.timeout as string, 10) * 60_000 : undefined,
        verbose: !!opts.verbose,
        dryRun: !!opts.dryRun,
      })
      printAgentResult(result, opts)
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ── purge — wiki purge agent ────────────────────────────────────────

program
  .command("purge")
  .description("Purge outdated/irrelevant wiki content")
  .option("--wiki <path>", "wiki root directory")
  .option("--stale-before <date>", "pure code: invalidate nodes updated before YYYY-MM-DD")
  .option("--slugs <list>", "pure code: comma-separated slugs to invalidate/delete")
  .option("--query <text>", "LLM agent: content-based judgment")
  .option("--report", "report mode: list candidates without modifying (for --query)")
  .option("--apply", "apply mode: execute purging (for --query)")
  .option("--hard-delete", "actually delete nodes instead of marking invalidated")
  .option("--superseded-by <slug>", "replacement node slug (for --slugs)")
  .option("--json", "machine-readable JSON output")
  .option("--max-iterations <n>", "max agent loop iterations (default 30)")
  .option("--timeout <minutes>", "timeout in minutes (default 10)")
  .option("--verbose", "print tool call logs to stderr")
  .option("--dry-run", "preview operations without writing")
  .addHelpText("after", timeoutGuidance(
    "  fast      targeted query, few candidates     --timeout 2\n" +
    "  medium    one-topic staleness review         --timeout 5\n" +
    "  max       content judgment across the wiki   --timeout 10 (default)\n" +
    "  ultra     whole-wiki audit in --apply mode   --timeout 20+\n\n" +
    "Applies to --query (LLM agent) mode only; --stale-before and --slugs are\n" +
    "pure code and finish instantly. Rough guidance, not hard rules — use\n" +
    "--verbose to watch progress and adjust.",
  ))
  .action(async (opts: Record<string, unknown>) => {
    const target = resolveTarget(opts.wiki as string | undefined, true)
    const wikiRoot = target.paths[0]

    try {
      // Path 1: date threshold (pure code)
      if (opts.staleBefore) {
        const { purgeByDate } = await import("../agent/purge.js")
        const result = await purgeByDate({
          wikiRoot,
          staleBefore: opts.staleBefore as string,
          hardDelete: !!opts.hardDelete,
          dryRun: !!opts.dryRun,
        })
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(`Scanned ${result.totalScanned} nodes, affected ${result.affected.length}:`)
          for (const a of result.affected) {
            console.log(`  ${a.action}: ${a.slug} (${a.title}) [updated: ${a.updated}]`)
          }
        }
        return
      }

      // Path 2: explicit slugs (pure code)
      if (opts.slugs) {
        const { purgeBySlugs } = await import("../agent/purge.js")
        const slugs = (opts.slugs as string).split(",").map((s) => s.trim()).filter(Boolean)
        const result = await purgeBySlugs({
          wikiRoot,
          slugs,
          hardDelete: !!opts.hardDelete,
          supersededBy: opts.supersededBy as string | undefined,
          dryRun: !!opts.dryRun,
        })
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          for (const a of result.affected) {
            console.log(`  ${a.action}: ${a.slug}`)
          }
          if (result.notFound.length > 0) {
            console.log(`  not found: ${result.notFound.join(", ")}`)
          }
        }
        return
      }

      // Path 3: LLM content judgment
      if (opts.query) {
        const mode = opts.apply ? "apply" : "report"
        const { runPurgeAgent } = await import("../agent/purge.js")
        const result = await runPurgeAgent({
          wikiRoot,
          query: opts.query as string,
          mode,
          hardDelete: !!opts.hardDelete,
          maxIterations: opts.maxIterations ? parseInt(opts.maxIterations as string, 10) : undefined,
          timeoutMs: opts.timeout ? parseInt(opts.timeout as string, 10) * 60_000 : undefined,
          verbose: !!opts.verbose,
          dryRun: !!opts.dryRun,
        })
        printAgentResult(result, opts)
        return
      }

      console.error("Error: specify one of --stale-before, --slugs, or --query")
      process.exit(1)
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ── check — wiki verification agent ─────────────────────────────────

program
  .command("check <query>")
  .description("Verify factual accuracy of wiki content via LLM agent")
  .option("--wiki <path>", "wiki root directory")
  .option("--json", "machine-readable JSON output")
  .option("--max-iterations <n>", "max agent loop iterations (default 30)")
  .option("--timeout <minutes>", "timeout in minutes (default 10)")
  .option("--verbose", "print tool call logs to stderr")
  .option("--dry-run", "preview operations without writing")
  .addHelpText("after", timeoutGuidance(
    "  fast      verify one node or claim           --timeout 2\n" +
    "  medium    verify one topic                   --timeout 5\n" +
    "  max       multi-node fact-check sweep        --timeout 10 (default)\n" +
    "  ultra     whole-wiki accuracy audit          --timeout 20+\n\n" +
    "Rough guidance, not hard rules — use --verbose to watch progress and adjust.",
  ))
  .action(async (query: string, opts: Record<string, unknown>) => {
    const target = resolveTarget(opts.wiki as string | undefined, true)
    const wikiRoot = target.paths[0]
    const { runCheck } = await import("../agent/check.js")
    try {
      const result = await runCheck({
        wikiRoot,
        query,
        maxIterations: opts.maxIterations ? parseInt(opts.maxIterations as string, 10) : undefined,
        timeoutMs: opts.timeout ? parseInt(opts.timeout as string, 10) * 60_000 : undefined,
        verbose: !!opts.verbose,
        dryRun: !!opts.dryRun,
      })
      printAgentResult(result, opts)
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ── reason — wiki deep reasoning agent ──────────────────────────────

program
  .command("reason <query>")
  .description("Deep graph reasoning: discover hidden connections, gaps, patterns")
  .option("--wiki <path>", "wiki root directory")
  .option("--report", "report mode: analyze only, don't write (default)")
  .option("--apply", "apply mode: write discovered connections to the graph")
  .option("--json", "machine-readable JSON output")
  .option("--max-iterations <n>", "max agent loop iterations (default 50)")
  .option("--timeout <minutes>", "timeout in minutes (default 10)")
  .option("--verbose", "print tool call logs to stderr")
  .option("--dry-run", "preview operations without writing")
  .addHelpText("after", timeoutGuidance(
    "  fast      shallow probe, 1-2 hops            --timeout 3\n" +
    "  medium    one causal walk, report mode       --timeout 5\n" +
    "  max       deep multi-hop reasoning           --timeout 10 (default)\n" +
    "  ultra     multi-question analysis / --apply  --timeout 20+\n\n" +
    "Reason walks the graph hop by hop and is the slowest agent — it is the\n" +
    "one most worth sizing --timeout for. Iterations matter too: with warm\n" +
    "caches each tool round is milliseconds, so broad or --apply walks hit\n" +
    "--max-iterations before the clock — bump it for open-ended exploration.\n" +
    "Rough guidance, not hard rules — use --verbose to watch progress and\n" +
    "adjust.",
  ))
  .action(async (query: string, opts: Record<string, unknown>) => {
    const target = resolveTarget(opts.wiki as string | undefined, true)
    const wikiRoot = target.paths[0]
    const { runReason } = await import("../agent/reason.js")
    try {
      const result = await runReason({
        wikiRoot,
        query,
        mode: opts.apply ? "apply" : "report",
        maxIterations: opts.maxIterations ? parseInt(opts.maxIterations as string, 10) : undefined,
        timeoutMs: opts.timeout ? parseInt(opts.timeout as string, 10) * 60_000 : undefined,
        verbose: !!opts.verbose,
        dryRun: !!opts.dryRun,
      })
      printAgentResult(result, opts)
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ── dream — offline consolidation agent ─────────────────────────────

program
  .command("dream [theme]")
  .description("Offline consolidation: recombine distant nodes, record insights, let unused knowledge decay")
  .option("--wiki <path>", "wiki root directory")
  .option("--pressure", "only report how much the wiki needs a dream, then exit (no model call)")
  .option("--dreams-dir <dir>", "where dream pages live (default wiki/dreams; must stay inside wiki/)")
  .option("--certainty <0..1>", "how tightly to stick to the theme: 1 hugs the graph, 0 roams (default 0.5)")
  .option("--max-iterations <n>", "dream depth: more iterations = a deeper, longer dream (default 50)")
  .option("--timeout <minutes>", "timeout in minutes (default 10)")
  .option("--json", "machine-readable JSON output")
  .option("--verbose", "print tool call logs to stderr")
  .option("--dry-run", "preview operations without writing")
  .addHelpText("after",
    "\nHow it works:\n" +
    "  Pure code picks the material — pressure reading, salience ranking, and\n" +
    "  seeded random walks that put distant nodes in one scene. The model then\n" +
    "  judges each candidate connection REAL / NOT REAL / UNCERTAIN, writes\n" +
    "  UNCERTAIN ones as dream pages under wiki/dreams/, and compresses nodes\n" +
    "  nobody reads one level at a time.\n\n" +
    "  Same day = same seed = same scenes (recorded in the journal), so a dream\n" +
    "  can be reproduced.\n\n" +
    "Examples:\n" +
    "  llm-wiki dream --pressure           check whether a dream is warranted\n" +
    "  llm-wiki dream                      free dream, defaults\n" +
    "  llm-wiki dream \"memory\" --certainty 0.8   stay close to one theme\n" +
    "  llm-wiki dream --certainty 0.2      roam widely, more teleports\n" +
    "  llm-wiki dream --dry-run            see what it would do, write nothing\n",
  )
  .action(async (theme: string | undefined, opts: Record<string, unknown>) => {
    const target = resolveTarget(opts.wiki as string | undefined, true)
    const wikiRoot = target.paths[0]
    const { runDream } = await import("../agent/dream.js")
    try {
      // Validate up front: a bad --certainty used to sail through as NaN and
      // silently produce a dream with zero scenes.
      let certainty: number | undefined
      if (opts.certainty !== undefined) {
        certainty = parseFloat(opts.certainty as string)
        if (!Number.isFinite(certainty) || certainty < 0 || certainty > 1) {
          console.error(`Error: --certainty must be a number between 0 and 1 (got "${opts.certainty}")`)
          process.exit(1)
        }
      }

      const result = await runDream({
        wikiRoot,
        theme,
        pressureOnly: !!opts.pressure,
        dreamsDir: opts.dreamsDir as string | undefined,
        certainty,
        maxIterations: opts.maxIterations ? parseInt(opts.maxIterations as string, 10) : undefined,
        timeoutMs: opts.timeout ? parseInt(opts.timeout as string, 10) * 60_000 : undefined,
        dryRun: !!opts.dryRun,
      })

      // --pressure is a pure reading: print it plainly, skip the agent framing.
      if (opts.pressure) {
        if (opts.json) console.log(JSON.stringify(result.pressure, null, 2))
        else console.log(result.finalMessage)
        return
      }

      // Print the scenes from the pure-code walk BEFORE the model's report.
      // The report is prose and models have been seen misdescribing their own
      // inputs ("0 scenes" when seven were injected); this block is ground truth.
      if (!opts.json && result.scenes?.length) {
        console.log(`\n── Dream scenes (${result.scenes.length}, seed ${result.seed}) ───────────`)
        result.scenes.forEach((scene, i) => {
          const walk = scene.hops.length
            ? scene.nodes[0] +
              scene.hops
                .map((h) => `${h.via === "edge" ? " —edge→ " : h.via === "teleport" ? " ⇢tp⇢ " : " ·de· "}${h.to}`)
                .join("")
            : scene.nodes[0]
          console.log(`  ${i + 1}. ${walk}`)
        })
      }
      printAgentResult(result, opts)
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ── Shared output helper ────────────────────────────────────────────

function printAgentResult(result: import("../agent/loop.js").AgentResult, opts: Record<string, unknown>) {
  if (opts.json) {
    console.log(JSON.stringify({
      status: result.status,
      iterations: result.iterations,
      conclusion: result.conclusion,
      toolCalls: result.toolCalls.map((tc) => ({
        tool: tc.tool,
        args: tc.args,
        error: tc.error,
        durationMs: tc.durationMs,
      })),
      finalMessage: result.finalMessage,
      runReport: result.runReport,
    }, null, 2))
  } else {
    if (opts.verbose) {
      for (const tc of result.toolCalls) {
        const status = tc.error ? "❌" : "✓"
        console.error(`  ${status} [iter ${tc.iteration}] ${tc.tool} (${tc.durationMs}ms)`)
      }
    }
    console.log(`\nStatus: ${result.status} (${result.iterations} iterations)`)

    if (result.error) {
      console.error(`\nError: ${result.error}`)
    }

    // Conclusion first — the answer to the user's query
    if (result.conclusion) {
      console.log(`\n── Conclusion ${"─".repeat(50)}`)
      console.log(result.conclusion)
    }

    if (result.runReport.dryRun && result.runReport.dryRunSummary) {
      console.log(`\n── Planned changes (dry-run, nothing written) ${"─".repeat(11)}`)
      console.log(result.runReport.dryRunSummary)
    } else if (result.runReport.changes.length > 0) {
      console.log(`\n── Changes ${"─".repeat(54)}`)
      for (const c of result.runReport.changes) {
        console.log(`  ${c.action}: ${c.file}`)
      }
    }

    // Fallback: if no conclusion, show the last assistant message
    if (!result.conclusion && result.finalMessage) {
      console.log(`\n${result.finalMessage}`)
    }
  }
  if (result.status === "error") {
    process.exit(1)
  }
}

program.parse()
