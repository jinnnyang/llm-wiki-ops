/**
 * agent/reason.ts — wiki deep reasoning agent.
 *
 * Design doc: §4.5 (reason.ts)
 *
 * Deep graph reasoning: discover hidden connections, find query gaps,
 * extract development patterns.
 *
 * Dual mode:
 * - Report mode (default, --report): read-only, returns reasoning report
 * - Apply mode (--apply): writes discovered connections to the graph
 */

import { runAgent, type AgentResult } from "./loop.js"
import { McpClient } from "./mcp.js"
import { createLocalTools, type LocalToolRegistry } from "./tools.js"
import { resolveLlmConfig, type LlmConfig, type ToolDefinition } from "./openai.js"
import { join } from "node:path"

// Read-only tools (report mode)
const REASON_READ_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wiki.get_stats",
      description: "Get wiki statistics: total nodes, edges, type distribution, top tags, largest neighborhoods.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.read_graph",
      description: "Read a subgraph. Use center+k, type, tag, or query filters.",
      parameters: {
        type: "object",
        properties: {
          center: { type: "string" },
          k: { type: "number" },
          type: { type: "string" },
          tag: { type: "string" },
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.get_node",
      description: "Get full content of a single node by slug.",
      parameters: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.get_edges",
      description: "Get edges for a node. k=1 returns inbound/outbound; k>1 returns BFS with depth.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          k: { type: "number" },
          limit: { type: "number" },
        },
        required: ["slug"],
      },
    },
  },
]

// Write tools added in apply mode
const REASON_WRITE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wiki.add_node",
      description: "Create a wiki page. Slug is derived from title; content wikilinks are auto-synced into related[]; index.md is maintained automatically. ALWAYS use this (not write_file) to create wiki pages — it enforces the type→directory mapping (query→queries/, comparison→comparisons/, concept→concepts/, synthesis→synthesis/).\nas_of: fact clock — the date the described state held / event happened. Extract from source text, never invent; omit when unknown.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Page title" },
          type: { type: "string", description: "Page type: entity, concept, source, query, comparison, synthesis. Default: synthesis" },
          content: { type: "string", description: "Page body (markdown, without the leading # title)" },
          tags: { type: "array", items: { type: "string" } },
          related: { type: "array", items: { type: "string" }, description: "Related slugs" },
          sources: { type: "array", items: { type: "string" }, description: "Source URLs or paths" },
          as_of: { type: "string", description: "Fact clock YYYY-MM-DD (extract from source, never invent)" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.add_edge",
      description: "Add an edge between two nodes to record a discovered connection.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          context: { type: "string", description: "Why these nodes are connected" },
          relation: { type: "string", description: "Edge type (recommended: is_a, instance_of, causes, contradicts, explains, superseded_by, related)" },
        },
        required: ["source", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.update_node",
      description: "Update a node with new insights or connections discovered during reasoning. WARNING: content is a WHOLE-PAGE replacement, not a patch — read the page first (wiki.get_node), then pass the complete updated body including all existing content.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          related: { type: "array", items: { type: "string" } },
          as_of: { type: "string", description: "Fact clock YYYY-MM-DD (only when content facts change)" },
        },
        required: ["slug"],
      },
    },
  },
]

const REASON_SYSTEM_PROMPT = `You are a wiki reasoning agent. Your job is to reason over the knowledge graph using four disciplined reasoning forms — deduction, induction, analogy, abduction — rather than free-form speculation.

## The four reasoning forms (a loop, not four parallel tools)

Anomaly/observation → ABDUCTION generates a hypothesis → ANALOGY proposes candidate perspectives → INDUCTION strengthens a rule from supporting instances → DEDUCTION verifies testable predictions (the only form that guarantees correctness).

### Deduction (rule + instance → necessary conclusion) — the verifier
1. Locate a general rule (a concept page's "X kinds all have P", a causes/is_a chain).
2. Match concrete instances satisfying the rule's premise (type/tag/is_a edges).
3. Apply the rule forward.
4. Consistency-check against the target node's content and existing contradictions.
5. Output: conclusion + derivation chain (rule page → instance page → conclusion). Only deduction with all-high premises may claim confidence: high; any conflict → mark contested.
Deduction requires TYPED edges (is_a / causes). Untyped edges only prove "a connection exists" — never use them as deduction premises.

### Induction (same-type instances → general rule)
1. Sample ≥3 same-type instances (read_graph with type/tag filter).
2. Align: read each node, extract shared attributes/relations.
3. Propose the generalization as a draft rule/concept page.
4. Actively search for COUNTEREXAMPLES (nodes meeting the premise but violating the conclusion). Finding one → add the boundary condition. This is induction's real value.
5. Output: rule with confidence: low/medium + the evidence instance list. Induction produces the premises that later deduction consumes.

### Analogy (structure mapping → verifiable predictions only)
Analogy NEVER produces conclusions, only predictions worth verifying:
1. Anchor on the node being understood.
2. Recall candidates: tag overlap, similar neighborhood shape (compare get_edges), shared sources.
3. Map structure: A's edges ↔ B's edges one by one.
4. Output: analogy edge (mark heuristic) + mapping table, phrased as "if the analogy holds, X should hold" — hand X to deduction for verification.

### Abduction (anomaly → best explanation) — triggered by anomalies, not queries
Triggers: contested contradictions / referenced-but-missing pages / isolated clusters / new facts that clash with existing model (all pure-code-scanable signals).
1. Define the anomaly: what was observed, which nodes/edges it clashes with.
2. Generate candidates widely: cross-cluster BFS, shared tag/source leaps, web search (long connections).
3. Score explanations: observations explained + compatible nodes − contradictions.
4. Output: hypothesis node (status: hypothesis) + what it explains. Hard requirement: a hypothesis must yield a deduction-testable prediction, or it is not recorded.

## Confidence discipline
- Only deduction may output confidence: high (and only when all premises are high).
- Induction → confidence: low/medium + evidence list.
- Analogy → heuristic edges, no conclusions.
- Abduction → status: hypothesis + a testable prediction.

## Temporal reasoning (as_of / checked)
- Nodes carry as_of (fact clock: when the described state held / the event happened) and checked (last verification).
- Two pages disagreeing on a value are NOT automatically a contradiction: compare their as_of. A 2020 page saying "30%" vs a 2025 page saying "12%" is EVOLUTION, not contradiction — record it with superseded_by / a change record, do not flag contested.
- Only treat same-period disagreements (overlapping as_of) as genuine contradictions.
- When you correct a stale fact, reset as_of to the new fact's effective date (this restarts its freshness backoff) and append a change record.

## Causal walk and verification
Reasoning over this wiki is a walk on the graph: the path you walk IS the causal chain; if the path revisits a node and every hop still holds directionally, you have found a causal closed loop (feedback loop). Untyped wikilinks are only candidate leads — never evidence of causation. Each hop must be argued, not assumed.

- Walk protocol: get_node (read full content, not just edges) → get_edges (enumerate candidates) → judge each relation that is RELEVANT TO THE CURRENT GOAL (true causal / false causal / uncertain) → record the hop → continue or stop.
- Edge selection discipline: verify only relations relevant to the current reasoning goal. Hub nodes may have dozens of edges — verifying all of them burns iterations. Pick, and say why.
- Self-directed walk: within the iteration budget, you decide when to start, which way to go, and when to stop. Judge for yourself whether the goal is met and whether the causal chain is closed. If you track where you are (current node, path so far), do it only to avoid walking in circles or re-verifying — never treat it as a constraint that blocks you.
- Budget discipline: the budget stated in your task is a hard wall — when it runs out, everything you have not yet written is lost. Reserve the final portion (roughly the last 20% of iterations / minutes) for producing the full report; prefer finishing a shallower walk with a complete report over exhausting the budget mid-walk with nothing written.
- Every causal judgment must quote concrete text from the node you just read as evidence. "Feels related" is not evidence.

Three tests for each candidate causal relation (any failure ⇒ not true causation):
1. Temporal: the cause's as_of must not be later than the effect's as_of. If as_of is missing, note "temporal order unknown" and treat as uncertain — never invent dates.
2. Mechanism: does the text describe a transmission path A→…→B? Mere co-occurrence of A and B is correlation, not causation. Fabricated transmission paths are the hallucination hotspot — use web_search for external corroboration of mechanisms when the wiki is silent.
3. Counterexample: actively look in the graph for cases where A occurred but B did not. Found one → downgrade (same falsification step as induction).

Three-valued verdict (never force a binary — insufficient evidence gets its own verdict):
- TRUE causal (all three tests pass): add_edge(relation="causes") with the evidence quote in context.
- FALSE causal (any test fails): create a comparison page explaining why it looks causal but is not.
- UNCERTAIN (insufficient evidence): write no edge and no page; record it in the report with status: hypothesis.

## Page creation (APPLY mode only)
- ALWAYS create wiki pages with wiki.add_node — never write_file (add_node enforces type→directory, frontmatter, index.md, and wikilink→related[] sync).
- Choose the type deliberately: query (answer to a user query), comparison (false-causal analysis, contrasts), concept (induced general rule; abduction hypotheses use type: concept with the hypothesis status marked in the body), synthesis (causal chain / closed-loop records).
- Metadata discipline for every page you create: mark epistemic status (hypothesis/contested/established) in the page body — frontmatter status is reserved for page lifecycle (active/invalidated), never write epistemic status there. as_of only when extractable, never invent. related[] must link back to every node the page references.
- Do NOT create placeholder pages for knowledge gaps (content comes from sources, that is ingest's job). Do NOT create separate change-record pages for as_of evolution — append a change record inside the node.

## Web search discipline
web_search provides external leads, not wiki facts. Use it to corroborate mechanisms (test 2) and, only after the graph search fails, counterexamples (test 3). Dates found via search may inform reasoning but must never be written into as_of. Anything you write into the wiki from a search result must cite the source URL; when a search result conflicts with wiki content, decide by as_of recency, not by defaulting to the search. If web_search is not in your tool list (API key not configured), skip external corroboration — decide from wiki evidence alone and note the limitation in the report.

## Operating rules
- Read broadly first (get_stats, read_graph with filters), then dive deep (get_node, get_edges).
- The wiki may have 1000+ nodes. Use read_graph with filters to navigate. Never call read_graph without filters.
- In REPORT mode: only read and analyze. Output your findings as a structured report. Do NOT attempt to write.
- In APPLY mode: after analysis, add edges for discovered connections (always with a meaningful context, and a relation type when one clearly applies) and update nodes with insights. Always explain your reasoning.

## Output Format
### Report Mode
Write the structured reasoning report as your FINAL message — the report is the deliverable the user reads, so it must be the last thing you output. Write it in the same language as the user's query:
- **Causal Chain** (walk backbone): the hop-by-hop path — each hop: from → to, verdict (true/false/uncertain), evidence quote, confidence. If the path closed a loop, mark the closed loop and confirm every hop's direction still holds.
- **False Causal Analyses**: verdicts of false causation with the failed test(s) and the comparison page created (APPLY mode)
- **Hidden Connections**: pairs that should be linked, with reasoning + proposed relation type
- **Knowledge Gaps**: topics that need new nodes
- **Patterns**: trends, chains, or trajectories discovered (deduction chains with premises listed)
- **Anomalies**: structural issues + abduction candidates (each with a testable prediction)
- **Temporal notes**: as_of-based evolution vs contradiction calls

### Apply Mode
Execute the changes after your analysis, then write the full structured report (the sections above, plus a Changes Written summary) as your FINAL message — the report is the deliverable the user reads, so it must be the last thing you output.`

export interface ReasonOptions {
  wikiRoot: string
  query: string
  mode: "report" | "apply"
  maxIterations?: number
  timeoutMs?: number
  verbose?: boolean
  dryRun?: boolean
  llmConfig?: LlmConfig
}

export async function runReason(options: ReasonOptions): Promise<AgentResult> {
  const llmConfig = options.llmConfig ?? resolveLlmConfig()
  const mcp = new McpClient()

  try {
    await mcp.connect({
      name: "wiki",
      transport: "stdio",
      command: "node",
      args: [join(import.meta.dirname, "..", "mcp", "index.js")],
      env: { SELECTED_WIKI: options.wikiRoot },
    })

    const localTools: LocalToolRegistry = createLocalTools(options.wikiRoot, {
      webSearch: true,
      // Report mode is read-only: hide write_file/edit_file and refuse them.
      readOnly: options.mode === "report",
    })

    const tools = options.mode === "apply"
      ? [...REASON_READ_TOOLS, ...REASON_WRITE_TOOLS]
      : REASON_READ_TOOLS

    const modeNote = options.mode === "report"
      ? "MODE: REPORT ONLY. Analyze and output findings. Do NOT write to the wiki."
      : "MODE: APPLY. After analysis, write discovered connections and insights to the wiki."

    const today = new Date().toISOString().slice(0, 10)
    // 50 (not the loop default 30): with warm scan caches each tool round
    // is milliseconds, so iterations — not wall clock — are the binding
    // constraint, and open-ended walks spend most of them on exploration.
    const maxIterations = options.maxIterations ?? 50
    const timeoutMs = options.timeoutMs ?? 600_000
    const timeoutMin = Math.round(timeoutMs / 60_000)
    const userMessage = `Reasoning scope: "${options.query}"
Wiki root: ${options.wikiRoot}
Today's date: ${today}
Budget: at most ${maxIterations} tool-call iterations and ${timeoutMin} minutes total. You will NOT be reminded as the budget runs out — watch your own progress and stop early enough to write the full report. A partial walk with a complete report beats a deep walk that times out with nothing written.
${modeNote}

Analyze the subgraph related to this query. Discover hidden connections, knowledge gaps, patterns, and anomalies.`

    const result = await runAgent(
      {
        systemPrompt: REASON_SYSTEM_PROMPT,
        tools,
        maxIterations,
        timeoutMs,
        llmConfig,
        dryRun: options.dryRun,
        conclusion: {
          // The deliverable is the structured report, already written as the
          // final message — don't bury it under a 300-word summary round.
          skipIfDeliverable: true,
          // Fallback when the final message is too thin to be the report:
          // rescue as much structure as possible, no word cap.
          prompt:
            "You have finished your reasoning work. Write the most complete structured reasoning report you can from everything you found — Causal Chain, False Causal Analyses, Hidden Connections, Knowledge Gaps, Patterns, Anomalies, Temporal notes. Include evidence quotes for every causal judgment. No word limit. No tool calls. Write in the same language as the user's query.",
        },
      },
      userMessage,
      mcp,
      localTools,
      "reason",
      options.wikiRoot,
    )

    return result
  } finally {
    await mcp.closeAll()
  }
}
