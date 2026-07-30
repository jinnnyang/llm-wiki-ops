/**
 * Test helpers — fixture wiki creation and teardown.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

export interface FixtureWiki {
  root: string
  wikiDir: string
  cleanup: () => Promise<void>
}

/**
 * Create a temporary wiki with 15+ pages across all known types.
 * Includes: wikilinks, related[], tags, code blocks with [[fake]] links,
 * dirty frontmatter data, NFKC edge cases, and a self-loop.
 */
export async function createFixtureWiki(): Promise<FixtureWiki> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-graph-test-"))
  const wikiDir = path.join(root, "wiki")

  // Create directories
  for (const dir of ["entities", "concepts", "sources", "queries", "comparisons", "synthesis"]) {
    await fs.mkdir(path.join(wikiDir, dir), { recursive: true })
  }

  const pages: Array<{ dir: string; file: string; content: string }> = [
    // ── Entities (4) ──
    {
      dir: "entities",
      file: "nvidia.md",
      content: `---
type: entity
title: "英伟达 (NVIDIA)"
created: "2025-01-15"
updated: "2025-06-01"
tags: ["半导体", "AI"]
related: ["hbm", "ai基建周期"]
---

# 英伟达 (NVIDIA)

GPU 龙头，AI 基建核心受益者。

## 核心矛盾

算力需求 vs 供应链瓶颈。

## 相关

- [[hbm]]
- [[ai基建周期]]
`,
    },
    {
      dir: "entities",
      file: "tsmc.md",
      content: `---
type: entity
title: "台积电 (TSMC)"
created: "2025-01-20"
updated: "2025-05-15"
tags: ["半导体", "代工"]
related: ["nvidia"]
---

# 台积电 (TSMC)

全球最大晶圆代工厂。

## 相关

- [[nvidia]]
`,
    },
    {
      dir: "entities",
      file: "openai.md",
      content: `---
type: entity
title: "OpenAI"
created: "2025-02-01"
updated: "2025-06-10"
tags: ["AI", "大模型"]
related: ["transformer"]
---

# OpenAI

GPT 系列模型开发者。

## 相关

- [[transformer]]
`,
    },
    {
      dir: "entities",
      file: "asml.md",
      content: `---
type: entity
title: "ASML"
created: "2025-03-01"
updated: "2025-03-01"
tags: ["半导体", "光刻"]
---

# ASML

EUV 光刻机垄断供应商。
`,
    },

    // ── Concepts (4) ──
    {
      dir: "concepts",
      file: "ai基建周期.md",
      content: `---
type: concept
title: "AI基建周期"
created: "2025-01-10"
updated: "2025-06-01"
tags: ["AI", "周期"]
related: ["nvidia", "hbm"]
---

# AI基建周期

AI 基础设施投资的周期性规律。

## 核心矛盾

资本开支 vs 回报周期。

## 相关

- [[nvidia]]
- [[hbm]]
`,
    },
    {
      dir: "concepts",
      file: "hbm.md",
      content: `---
type: concept
title: "HBM (高带宽内存)"
created: "2025-01-12"
updated: "2025-05-20"
tags: ["半导体", "存储"]
related: ["nvidia", "ai基建周期"]
---

# HBM (高带宽内存)

High Bandwidth Memory，AI 芯片关键组件。

## 相关

- [[nvidia]]
- [[ai基建周期]]
`,
    },
    {
      dir: "concepts",
      file: "transformer.md",
      content: `---
type: concept
title: "Transformer 架构"
created: "2025-02-05"
updated: "2025-04-01"
tags: ["AI", "架构"]
related: ["openai"]
---

# Transformer 架构

Attention Is All You Need.

## 相关

- [[openai]]
`,
    },
    {
      dir: "concepts",
      file: "kv-cache.md",
      content: `---
type: concept
title: "KV Cache"
created: "2025-03-10"
updated: "2025-03-10"
tags: ["AI", "推理"]
---

# KV Cache

推理加速的关键技术。

代码示例（不应被提取为 wikilink）：

\`\`\`python
# [[这不是wikilink]]
cache = {}
\`\`\`

行内代码 \`[[也不是]]\` 不应提取。
`,
    },

    // ── Sources (2) ──
    {
      dir: "sources",
      file: "nvidia-10k-2025.md",
      content: `---
type: source
title: "NVIDIA 10-K 2025"
created: "2025-04-01"
updated: "2025-04-01"
tags: ["财报"]
related: ["nvidia"]
---

# NVIDIA 10-K 2025

Annual report.

## 相关

- [[nvidia]]
`,
    },
    {
      dir: "sources",
      file: "semiconductor-outlook.md",
      content: `---
type: source
title: "半导体行业展望 2025"
created: "2025-05-01"
updated: "2025-05-01"
tags: ["半导体", "研报"]
related: ["hbm", "asml"]
---

# 半导体行业展望 2025

行业研报。

## 相关

- [[hbm]]
- [[asml]]
`,
    },

    // ── Queries (1) ──
    {
      dir: "queries",
      file: "ai-capex-trend.md",
      content: `---
type: query
title: "AI CapEx 趋势"
created: "2025-05-15"
updated: "2025-05-15"
tags: ["AI"]
related: ["ai基建周期", "nvidia"]
---

# AI CapEx 趋势

查询：AI 资本开支趋势如何？

## 相关

- [[ai基建周期]]
- [[nvidia]]
`,
    },

    // ── Comparisons (1) ──
    {
      dir: "comparisons",
      file: "nvidia-vs-amd.md",
      content: `---
type: comparison
title: "NVIDIA vs AMD"
created: "2025-06-01"
updated: "2025-06-01"
tags: ["半导体", "AI"]
related: ["nvidia"]
---

# NVIDIA vs AMD

GPU 竞争格局对比。

## 相关

- [[nvidia]]
`,
    },

    // ── Synthesis (1) ──
    {
      dir: "synthesis",
      file: "ai-supply-chain-synthesis.md",
      content: `---
type: synthesis
title: "AI 供应链综合分析"
created: "2025-06-15"
updated: "2025-06-15"
tags: ["AI", "半导体"]
related: ["nvidia", "tsmc", "hbm", "ai基建周期"]
---

# AI 供应链综合分析

综合多个来源的分析。

## 相关

- [[nvidia]]
- [[tsmc]]
- [[hbm]]
- [[ai基建周期]]
`,
    },

    // ── Overview (1) ──
    {
      dir: "",
      file: "overview.md",
      content: `---
type: overview
title: "Wiki 总览"
created: "2025-01-01"
updated: "2025-06-15"
---

# Wiki 总览

本 wiki 追踪 AI 和半导体产业链。
`,
    },

    // ── Dirty data page (1): related has [[wikilink]] format ──
    {
      dir: "concepts",
      file: "dirty-data.md",
      content: `---
type: concept
title: "脏数据测试页"
created: "2025-07-01"
updated: "2025-07-01"
tags: ["test"]
related: ["[[nvidia]]", "hbm"]
---

# 脏数据测试页

related 字段包含 [[wikilink]] 格式的脏数据。

## 相关

- [[nvidia]]
`,
    },

    // ── NFKC edge case (1): fullwidth chars in title ──
    {
      dir: "entities",
      file: "ｔｅｓｔ-ｎｆｋｃ.md",
      content: `---
type: entity
title: "Ｔｅｓｔ ＮＦＫＣ"
created: "2025-07-01"
updated: "2025-07-01"
tags: ["test"]
---

# Ｔｅｓｔ ＮＦＫＣ

Fullwidth title for NFKC normalization testing.
`,
    },

    // ── No-frontmatter page (1) ──
    {
      dir: "concepts",
      file: "bare-page.md",
      content: `# 裸页面

没有 frontmatter 的页面。

## 相关

- [[nvidia]]
`,
    },
  ]

  for (const page of pages) {
    const dir = page.dir ? path.join(wikiDir, page.dir) : wikiDir
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, page.file), page.content, "utf-8")
  }

  // Create index.md
  await fs.writeFile(
    path.join(wikiDir, "index.md"),
    `# Wiki Index

## Entities

- [[asml]] — ASML
- [[nvidia]] — 英伟达 (NVIDIA)
- [[openai]] — OpenAI
- [[tsmc]] — 台积电 (TSMC)

## Concepts

- [[ai基建周期]] — AI基建周期
- [[bare-page]] — 裸页面
- [[dirty-data]] — 脏数据测试页
- [[hbm]] — HBM (高带宽内存)
- [[kv-cache]] — KV Cache
- [[transformer]] — Transformer 架构

## Sources

- [[nvidia-10k-2025]] — NVIDIA 10-K 2025
- [[semiconductor-outlook]] — 半导体行业展望 2025

## Queries

- [[ai-capex-trend]] — AI CapEx 趋势

## Comparisons

- [[nvidia-vs-amd]] — NVIDIA vs AMD

## Synthesis

- [[ai-supply-chain-synthesis]] — AI 供应链综合分析

## Overview

- [[overview]] — Wiki 总览

## Custom Notes

This is a custom section that should survive rebuildIndex.
`,
    "utf-8",
  )

  return {
    root,
    wikiDir,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
