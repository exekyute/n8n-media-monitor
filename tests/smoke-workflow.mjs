// Smoke-test: extract the embedded jsCode from each Code node in the built
// workflow JSON and execute it inside a minimal n8n shim. Catches any
// regressions introduced by the inlining step in scripts/build-workflow.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const wf = JSON.parse(readFileSync(resolve(ROOT, 'workflows/media-monitor.workflow.json'), 'utf8'));

function codeFor(name) {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error('no node: ' + name);
  return n.parameters.jsCode;
}

// Minimal shim: $('Config').first().json, $getWorkflowStaticData, items
function runCodeNode({ code, items, contextItems, staticData }) {
  const $ = (name) => ({
    first: () => ({ json: contextItems[name] })
  });
  const $getWorkflowStaticData = () => staticData;
  // Code is in module top-level shape (uses `items`, `return`). Wrap in fn.
  const fn = new Function('$', '$getWorkflowStaticData', 'items', code);
  return fn($, $getWorkflowStaticData, items);
}

// Get a sane cfg by executing the Config node body.
const cfgItems = runCodeNode({
  code: codeFor('Config'),
  items: [],
  contextItems: {},
  staticData: {}
});
const cfg = cfgItems[0].json;
assert.ok(Array.isArray(cfg.feeds) && cfg.feeds.length > 0, 'config feeds');
assert.ok(Array.isArray(cfg.topics) && cfg.topics.length > 0, 'config topics');

// Feed URLs node
const feedItems = runCodeNode({
  code: codeFor('Feed URLs'),
  items: [],
  contextItems: { Config: cfg },
  staticData: {}
});
assert.equal(feedItems.length, cfg.feeds.length);
assert.equal(feedItems[0].json.url, cfg.feeds[0]);

// Process Articles: synthetic RSS items
const fakeNow = '2026-05-25T12:00:00Z';
const rssItems = [
  { json: {
      title: 'Acme posts record growth in Q1',
      link: 'https://www.reuters.com/business/acme-growth?utm_source=feed',
      summary: '<p>Acme reported strong profit growth. acme acme.</p>',
      pubDate: '2026-05-25T10:00:00Z'
  }},
  { json: {
      title: 'New regulation tightens',
      link: 'https://www.bbc.co.uk/news/regulation-update',
      summary: 'Regulators issued a fresh regulation today.',
      pubDate: '2026-05-25T08:00:00Z'
  }},
  // Should be dropped (no topic match):
  { json: {
      title: 'Sports roundup',
      link: 'https://example.com/sports/123',
      summary: 'Generic sports content.',
      pubDate: '2026-05-25T07:00:00Z'
  }},
  // Duplicate of first (utm differs):
  { json: {
      title: 'Acme posts record growth in Q1',
      link: 'https://www.reuters.com/business/acme-growth?utm_campaign=z',
      summary: '<p>Acme reported strong profit growth.</p>',
      pubDate: '2026-05-25T10:00:00Z'
  }}
];

const staticData = {};
const enriched = runCodeNode({
  code: codeFor('Process Articles'),
  items: rssItems,
  contextItems: { Config: cfg },
  staticData
});

const titles = enriched.map(e => e.json.title);
console.log('  enriched titles:', titles);
assert.equal(enriched.length, 2, 'expected 2 enriched items (1 brand + 1 reg, 1 dup removed, 1 no-match dropped)');
assert.ok(enriched.every(e => typeof e.json.relevance === 'number'));
assert.ok(enriched.every(e => ['positive', 'neutral', 'negative'].includes(e.json.sentiment)));
assert.ok(Array.isArray(staticData.seen) && staticData.seen.length === 2, 'seen list populated');

// Second pass with same items → dedup drops all.
const secondPass = runCodeNode({
  code: codeFor('Process Articles'),
  items: rssItems,
  contextItems: { Config: cfg },
  staticData
});
assert.equal(secondPass.length, 0, 'second pass dedup drops everything');

// Build Digest — feed enriched in.
const digest = runCodeNode({
  code: codeFor('Build Digest'),
  items: enriched,
  contextItems: { Config: cfg },
  staticData
});
assert.equal(digest.length, 1, 'digest emits one item');
const out = digest[0].json;
assert.ok(out.subject.startsWith(cfg.digest.subjectPrefix), 'subject has prefix');
assert.ok(out.html.includes('<h1'), 'html has h1');
assert.ok(out.html.includes('BrandMentions') || out.html.includes('RegulatoryNews'), 'topic heading present');
assert.equal(out.to, cfg.digest.to);
assert.equal(out.from, cfg.digest.from);

// Empty digest path
const emptyDigest = runCodeNode({
  code: codeFor('Build Digest'),
  items: [],
  contextItems: { Config: cfg },
  staticData
});
assert.equal(emptyDigest.length, 1);
assert.ok(emptyDigest[0].json.html.includes('No new matches'));

console.log('\nOK smoke-workflow: Process Articles + Build Digest behave correctly inside the shim');
