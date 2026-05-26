# Media Monitor — rule-based social listening for n8n

A self-hosted **n8n** workflow that scans RSS/Atom feeds for topics relevant to
your company (brand mentions, competitors, regulatory news), enriches every
matching article with **relevance, sentiment, and entity tags**, and ships the
result to two destinations:

1. **Google Sheets** — every match appended as an archive row.
2. **HTML email digest** — grouped by topic, sorted by relevance.

All intelligence is pure rule-based
JavaScript inside n8n Code nodes. That means:

- **Deterministic.** Same input → same output. Easy to audit.
- **Free at runtime.** No API keys beyond SMTP and Google Sheets.
- **Self-contained.** Cross-run dedup uses `$getWorkflowStaticData('global')`,
  so there is nothing to provision — no Redis, no database, no third party.
- **Portable.** Import the JSON, paste your feeds, add credentials, done.

---

## Node graph

```
                              ┌─→ Google Sheets — Append   (archive)
Schedule → Config → Feed URLs │
   Trigger   (Code)   (Code)  │
                      │       └─→ Build Digest → Send Email (digest)
                      ▼            (Code)        (SMTP)
                   RSS Read
                  (per feed)
                      │
                      ▼
              Process Articles
                   (Code)
                  the brain
```

![Workflow canvas](docs/workflow.png)

---

## What's in the box

| Path | What it is |
|------|-----------|
| `workflows/media-monitor.workflow.json` | Importable n8n workflow. **Authoritative artifact.** Code-node bodies are embedded — no external requires at runtime. |
| `src/lib.mjs` | Readable, unit-testable copies of every pure function the workflow uses (`normalizeArticle`, `hashLink`, `matchTopics`, `scoreRelevance`, `scoreSentiment`, `tagEntities`). |
| `tests/selftest.mjs` | Node-only self-test. No n8n needed. Asserts matching, scoring, sentiment, normalization, hashing, dedup. |
| `examples/config.example.js` | Realistic `Config` Code-node body with 3 named topics, scoring weights, starter lexicon, entity dictionary. |
| `scripts/build-workflow.mjs` | Re-generates the workflow JSON from `src/lib.mjs` + `examples/config.example.js`. Run after editing the lib. |
| `docs/workflow.png` | Screenshot placeholder. Replace after import. |

---

## Import

1. Open n8n → **Workflows** → **Import from File**.
2. Pick `workflows/media-monitor.workflow.json`.
3. The workflow imports inactive. Don't activate yet — configure first.

The workflow targets these n8n core node versions:

| Node | Type | Version |
|------|------|---------|
| Schedule Trigger | `n8n-nodes-base.scheduleTrigger` | 1.2 |
| Config / Feed URLs / Process Articles / Build Digest | `n8n-nodes-base.code` | 2 |
| RSS Read | `n8n-nodes-base.rssFeedRead` | 1 |
| Google Sheets — Append | `n8n-nodes-base.googleSheets` | 4 |
| Send Email | `n8n-nodes-base.emailSend` | 2 |

If your n8n is older you may need to drop the `typeVersion` on any flagged
node (n8n usually offers a one-click fix on import).

---

## Configure

Open the **Config** node and edit the returned object. The shape is documented
inline in [`examples/config.example.js`](examples/config.example.js). At a
minimum, edit:

- `feeds[]` — your RSS/Atom URLs.
- `topics[]` — named topics with `include` (boolean AND) and `exclude`
  (any-match suppresses). An article must match at least one topic to survive.
- `entities` — label → list of aliases for entity tagging.
- `digest.to` / `digest.from` — email addresses.

Topic match is **whole-word, case-insensitive**, so `include: ["mac"]` will
not match inside `macro`.

---

## Credentials

Two credentials, both set inside their nodes after import:

1. **Send Email (SMTP)** — pick or create an SMTP credential.
2. **Google Sheets — Append** — Google Sheets OAuth2 credential. Bind the
   spreadsheet and sheet/tab in the node UI. Append mode is set to
   `autoMapInputData`, so every field on the enriched article becomes a
   column. Use the columns the workflow emits as your header row:

   `title, link, source, publishedAt, summary, topics, entities, relevance, sentiment, sentimentScore, hash, scannedAt`

---

## How it works

### Topic match (boolean, whole-word)

For each topic, every term in `include` must appear in the article (title +
content); if any term in `exclude` appears, the topic is suppressed. Articles
matching no topic are dropped.

### Relevance score (0–100)

```
score = clamp(0..100, round(
    termWeight   * min(totalIncludeHits, 10)
  + sourceWeight * min(sources[host] || sources.default || 1, 2)
  + recencyWeight * max(0, 1 - hoursOld / recencyHalfLifeHours)
))
```

Tune `termWeight`, `sourceWeight`, `recencyWeight`, `recencyHalfLifeHours`,
and per-host multipliers in `scoring`.

### Sentiment (AFINN-style)

Sum of `lexicon[word]` across whole-word tokens, normalised by
`sqrt(tokenCount)` so long articles don't dominate. Label thresholds:

- `score ≥ +0.5` → **positive**
- `score ≤ −0.5` → **negative**
- otherwise → **neutral**

### Entity tagging

Each label in `entities` is attached if any of its aliases matches the article
(whole-word, case-insensitive). Each label is attached at most once.

### Cross-run dedup

`Process Articles` reads `$getWorkflowStaticData('global').seen`, a list of
short link hashes. New articles are hashed (`hashLink` lowercases, strips
`utm_*` / `gclid` / `fbclid`, drops trailing slash and fragment, then djb2),
checked against the set, and added if new. The list is trimmed to `seenCap`
entries FIFO so it stays bounded.

This means an article appears in **exactly one** digest, even if it's
re-published on another feed or re-sent with tracking parameters.

### Each article in every matching topic

If an article matches `BrandMentions` **and** `RegulatoryNews`, it appears
under both sections of the digest. The archive row stores the topics as a
comma-separated string so a single Sheets row is enough.

---

## Self-test

```sh
cd media-monitor
node tests/selftest.mjs
```

You should see `OK 11/11`. The test asserts:

- Topic include match + exclude suppression.
- Whole-word boundary (`mac` does **not** match inside `macro`).
- Relevance: fresh + boosted source + many hits → ≥ 70.
- Relevance: old + generic source + single hit → ≤ 30.
- Sentiment labels: positive / negative / neutral.
- Entity tagging via alias.
- `normalizeArticle` strips HTML and entities, derives source from link host.
- `hashLink` is stable under `utm_*` and trailing slash; distinct links differ.
- Dedup via `Set` (same shape as the static-data seen-list) suppresses repeats.

## Validate the workflow JSON

```sh
node -e "JSON.parse(require('fs').readFileSync('workflows/media-monitor.workflow.json','utf8')); console.log('OK')"
```

## Re-generate the workflow after editing the lib

```sh
node scripts/build-workflow.mjs
```

This re-reads `src/lib.mjs` and `examples/config.example.js` and rewrites the
workflow JSON with the new Code-node bodies.

---

## Manual verification (after import)

1. Edit the **Config** node — paste your feeds, topics, and entities.
2. Add credentials on **Google Sheets — Append** and **Send Email**.
3. Click **Execute Workflow**. Expect:
   - Rows appear in your sheet.
   - A digest email lands in your inbox grouped by topic.
4. Click **Execute Workflow** again. Expect:
   - No new sheet rows (every article is already in the seen-list).
   - No empty email — `Process Articles` returns `[]`, so neither delivery
     node fires.
5. Activate the workflow. The Schedule Trigger now runs hourly (configurable
   in the trigger UI).

---

## Customizing

- **Per-source weight** — drop a host into `scoring.sources`. e.g.
  `"yourindustryrag.example": 1.8`.
- **New topic** — append to `topics[]`. Each topic is independent.
- **New entity** — add a label to `entities` with its alias list. Aliases are
  whole-word and case-insensitive.
- **New sentiment word** — add to `lexicon` with an integer score
  (positive/negative, conventionally −5..+5).
- **Different schedule** — edit the Schedule Trigger node (every N minutes,
  hours, days, or cron).

---

## Troubleshooting

- **No email** — `Process Articles` only emits items if at least one article
  passed match + dedup. An empty run is normal; activate the workflow and
  wait for a real hit, or temporarily widen a topic.
- **One feed errors out** — RSS Read is set to `continueRegularOutput`, so
  other feeds still flow. Open the node's execution log to see the failing
  URL.
- **Digest shows the same article twice** — it matched two topics. That's by
  design; each topic section is independent. If you don't want this, edit
  `Build Digest` to keep only the first topic per article.
- **Static data lost** — `$getWorkflowStaticData('global')` persists per
  workflow on the n8n instance. If you re-import the workflow, the seen-list
  starts empty. The first run after re-import will look like a flood.

---

## License

MIT — see [LICENSE](LICENSE).
