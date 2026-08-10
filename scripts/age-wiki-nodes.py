"""
Age a wiki so the forgetting ladder has genuinely stale material.

The blocker in the previous runs was not the mechanism — it was that a 45-day-old
copy has no node that is plausibly worthless. The dream kept judging, correctly,
"not clearly worthless yet". A real wiki that has run for a year has nodes nobody
has touched since creation, whose reference clock is long overdue.

This backdates a chosen set of low-value nodes: created/updated pushed far into
the past, as_of aged so freshness reports them overdue, and their inbound edges
pruned so nothing depends on them. That is what genuine decay candidates look
like — we are constructing the situation, not faking the outcome.
"""

import os, re, sys, glob, random
from datetime import datetime, timedelta, timezone

ROOT = sys.argv[1]
COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 12
AGE_DAYS = int(sys.argv[3]) if len(sys.argv) > 3 else 400

# Destructive and irreversible: rewrites frontmatter dates and severs inbound
# links. Only ever point it at a throwaway copy. The guard is a path check rather
# than a prompt because this is meant to run unattended in a test script.
_low = ROOT.replace("\\", "/").lower()
if not any(k in _low for k in ("temp", "tmp", "test", "fixture")):
    sys.exit(
        f"refusing to age {ROOT}\n"
        "This script rewrites dates and cuts inbound links in place. Run it on a\n"
        "copy under a temp/test path, never on a wiki you care about.\n"
        "Override by copying the wiki first, e.g. to %TEMP%\\my-wiki-test."
    )

wiki = os.path.join(ROOT, "wiki")
old = (datetime.now(timezone.utc) - timedelta(days=AGE_DAYS)).strftime("%Y-%m-%d")

# Candidates: knowledge nodes only. Never source/overview/dream.
pages = []
for p in glob.glob(os.path.join(wiki, "**", "*.md"), recursive=True):
    base = os.path.basename(p)
    if base in ("index.md", "log.md"):
        continue
    head = open(p, encoding="utf-8").read()[:900]
    m = re.search(r"^type:\s*(\S+)", head, re.M)
    t = m.group(1).strip('"') if m else ""
    if t in ("entity", "concept", "query", "comparison", "synthesis"):
        pages.append((p, t))

random.seed(99)
random.shuffle(pages)

# Prefer pages with few inbound links: count how often each slug is referenced.
refs = {}
for p in glob.glob(os.path.join(wiki, "**", "*.md"), recursive=True):
    txt = open(p, encoding="utf-8").read()
    for tgt in re.findall(r"\[\[([^\]|]+)", txt):
        s = os.path.basename(tgt.strip()).lower()
        refs[s] = refs.get(s, 0) + 1

def inbound(path):
    return refs.get(os.path.splitext(os.path.basename(path))[0].lower(), 0)

pages.sort(key=lambda pt: inbound(pt[0]))
chosen = pages[:COUNT]

aged = []
for path, _t in chosen:
    txt = open(path, encoding="utf-8").read()
    slug = os.path.splitext(os.path.basename(path))[0]

    txt = re.sub(r'^(created:\s*).*$', rf'\1"{old}"', txt, count=1, flags=re.M)
    txt = re.sub(r'^(updated:\s*).*$', rf'\1"{old}"', txt, count=1, flags=re.M)
    if re.search(r'^as_of:', txt, re.M):
        txt = re.sub(r'^(as_of:\s*).*$', rf'\1"{old}"', txt, count=1, flags=re.M)
    else:
        txt = re.sub(r'^(updated:.*)$', rf'\1\nas_of: "{old}"', txt, count=1, flags=re.M)

    open(path, "w", encoding="utf-8").write(txt)
    aged.append((slug, inbound(path)))

# Cut inbound references so nothing depends on them any more.
targets = {s.lower() for s, _ in aged}
cut = 0
for p in glob.glob(os.path.join(wiki, "**", "*.md"), recursive=True):
    if os.path.splitext(os.path.basename(p))[0].lower() in targets:
        continue
    txt = open(p, encoding="utf-8").read()
    orig = txt
    for slug, _ in aged:
        # de-link in body, and drop from related[]
        txt = txt.replace(f"[[{slug}]]", slug)
        txt = re.sub(rf'^\s*-\s*{re.escape(slug)}\s*$', '', txt, flags=re.M)
    if txt != orig:
        open(p, "w", encoding="utf-8").write(txt)
        cut += 1

print(f"aged {len(aged)} nodes to {old} ({AGE_DAYS}d old); pruned inbound refs in {cut} files")
for s, n in aged:
    print(f"  {s[:52]:54} had_inbound={n}")
