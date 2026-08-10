/**
 * agent/dream-citation.ts — the wake-side discipline for citing dream pages.
 *
 * Design: dream.md §7.3 (the P3 item: "清醒侧联动 — reason/research/check prompt
 * 加 UNVERIFIED 引用纪律").
 *
 * Why this exists: dream pages are first-class graph nodes on purpose — that is
 * what lets check pull them in and settle them. The cost is that they come back
 * from ordinary reads. A live check: query "钨" on a real wiki returned 5 nodes,
 * one of which was `type: dream`, sitting in the list beside three established
 * concept nodes with nothing but the type field to tell them apart. None of the
 * three wake-side prompts mentioned UNVERIFIED at all, so nothing stopped an
 * agent from citing a dream's speculation as established fact and propagating it
 * into a new node.
 *
 * One shared constant rather than three copies: the rule is identical for every
 * wake-side agent, and three hand-maintained copies would drift (the same
 * reasoning that made KNOWN_HEADINGS derive from KNOWN_TYPE_ORDER).
 */

/**
 * Prompt section telling a wake-side agent how to treat `type: dream` nodes.
 *
 * Ends without a trailing newline so callers control spacing.
 */
export const DREAM_CITATION_DISCIPLINE = `## Dream pages are NOT evidence
Ordinary reads return dream pages. \`wiki.read_graph\` and \`wiki.get_node\` do not filter them out, so a \`type: dream\` node can appear in your results next to established concept and source nodes.

How to recognise one:
- \`type: dream\` in the node metadata, and
- the body opens with \`> **UNVERIFIED DREAM**\`.

A dream page records an offline recombination — a hunch the dream agent could not settle from the wiki's own contents. It is a QUESTION, never a finding.

- NEVER cite a dream page as support for a claim, and never copy its assertions into a node you write as if they were established.
- NEVER use one as a source: it has no \`sources\`, because it has no evidence behind it.
- Its wikilinks are the nodes it drew on. If a dream's idea looks relevant, go read THOSE nodes and judge from their content — the dream's own framing carries no weight.
- You MAY treat it as a lead worth investigating, and say so explicitly: "dream page X raises the question of Y; the underlying nodes show Z."
- If your work settles a dream's question, say which dream page and how in your report. Verifying dreams is how they graduate into knowledge or get discarded.`
