Scan the news feeds that matter to your organization and send each team a scored HTML digest of only its own coverage, for the cost of a single SMTP credential.

## Who's it for

Government and public-sector communications departments that scan the news daily and send each client department its relevant coverage. Also fits PR, public affairs, and ops teams tracking brand, competitor, or regulatory mentions on self-hosted n8n.

## How it works

A Schedule Trigger runs hourly, and the Config node holds every setting in one place: feeds, topics, scoring, lexicon, entities, recipients, and routes. Feeds are fetched independently, so one broken feed never stops the rest.

Process Articles applies whole-word topic rules, scores relevance 0 to 100 and sentiment, tags entities, and de-duplicates across runs. Build Digest renders one scored HTML email per audience: the full digest plus one per route, so each department sees only its own topics. Empty runs are skipped.

## How to set up

1. Edit feeds, topics, entities, and recipients in the Config node.
2. Attach an SMTP credential on the Send Email node.
3. Execute once to test, then activate.

## Requirements

- Self-hosted n8n (uses Code nodes and workflow static data).
- One SMTP credential. Nothing else: no other accounts, databases, or API keys.

## How to customize the workflow

Add a route per client department in digest.routes, tune scoring weights and per-source multipliers, extend the sentiment lexicon, change the schedule, or raise digest.minRelevance to cut noise.
