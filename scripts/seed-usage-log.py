"""
Seed a realistic usage distribution so the forgetting ladder has real candidates.

Why this is needed: on a freshly copied wiki every page has usage30=0, so
salience degenerates into "inDegree only" and the bottom of the ranking fills up
with the dream's own freshly written pages plus isolated source pages. The model
is then shown its own five-minute-old output as the forgetting candidates — and
correctly declines to compress them. Three live runs did zero compression for
exactly this reason.

Real wikis accumulate a skewed access pattern: a few hub concepts get read
constantly, a long tail never gets touched. This script fabricates that pattern
directly into the usage log (the same JSONL format UsageLogger writes), so
computeUsageStats sees history and salience can separate "load-bearing" from
"forgotten".

Deliberately writes as actor "reason"/"check"/"cli" — never "dream", because
prepareDream passes excludeActor:"dream" and dream's own reads must not count.
"""

import json, os, random, sys
from datetime import datetime, timedelta, timezone

ROOT = sys.argv[1]
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 45

wiki = os.path.join(ROOT, "wiki")
slugs = []
for dirpath, _, files in os.walk(wiki):
    for f in files:
        if f.endswith(".md") and f not in ("index.md", "log.md"):
            slugs.append(os.path.splitext(f)[0])

random.seed(20260810)  # reproducible
random.shuffle(slugs)

# A plausible skew: 5% hot (read often), 15% warm, 80% never touched at all.
hot = slugs[: max(1, len(slugs) // 20)]
warm = slugs[len(hot) : len(hot) + max(1, len(slugs) // 7)]
cold = slugs[len(hot) + len(warm) :]

usage_dir = os.path.join(ROOT, ".llm-wiki-ops", "usage")
os.makedirs(usage_dir, exist_ok=True)

ACTORS = ["reason", "check", "cli", "research"]
READ_OPS = ["get_node", "get_edges", "read_graph"]

total = 0
for d in range(DAYS):
    day = datetime.now(timezone.utc) - timedelta(days=d)
    lines = []

    def emit(slug, n):
        global total
        for _ in range(n):
            ts = day.replace(
                hour=random.randint(0, 23), minute=random.randint(0, 59), second=random.randint(0, 59)
            )
            lines.append(
                json.dumps(
                    {
                        "ts": ts.isoformat().replace("+00:00", "Z"),
                        "op": random.choice(READ_OPS),
                        "slug": slug,
                        "actor": random.choice(ACTORS),
                        "ok": True,
                    },
                    ensure_ascii=False,
                )
            )
            total += 1

    for s in random.sample(hot, k=max(1, len(hot) // 2)):
        emit(s, random.randint(2, 6))
    for s in random.sample(warm, k=max(1, len(warm) // 8)):
        emit(s, 1)

    if lines:
        path = os.path.join(usage_dir, day.strftime("%Y-%m-%d") + ".jsonl")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

print(f"pages={len(slugs)} hot={len(hot)} warm={len(warm)} cold={len(cold)}")
print(f"seeded {total} read events across {DAYS} days into {usage_dir}")
