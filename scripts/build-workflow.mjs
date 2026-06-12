// Builds workflows/media-monitor.workflow.json from the lib + config + node
// bodies defined below. Run: `node scripts/build-workflow.mjs`.
//
// We keep this so re-generating the workflow after editing the lib is a
// one-liner instead of a hand-escaped JSON edit.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Deterministic node ID from a name. Keeps `node build` reproducible so
// `node build --check` can verify drift in CI without false positives.
function nodeId(name) {
  return createHash('sha1').update('media-monitor:' + name).digest('hex').slice(0, 36);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const libSrc = readFileSync(join(ROOT, 'src/lib.mjs'), 'utf8');
const configSrc = readFileSync(join(ROOT, 'examples/config.example.js'), 'utf8');

// Strip `export ` from lib so we can paste it as plain functions inside a
// Code node, and drop the leading file-header comment to keep nodes tidy.
const libInline = libSrc
  .replace(/^\/\/ media-monitor:[\s\S]*?\n\n/, '')
  .replace(/export\s+function/g, 'function');

// Pull the "return [...]" body from the example config verbatim.
const configBody = configSrc.slice(configSrc.indexOf('return [{'));

// ---- Code node bodies -------------------------------------------------------

const feedUrlsCode = `// Fan out: one item per feed URL from Config.
const feeds = $('Config').first().json.feeds || [];
return feeds.map(url => ({ json: { url } }));
`;

const processCode = `// Process Articles: rule-based enrichment.
// Pure functions are inlined below (copy of src/lib.mjs) so this node is
// self-contained inside the exported workflow. Edit src/lib.mjs and re-run
// scripts/build-workflow.mjs to regenerate.

${libInline}

const cfg = $('Config').first().json;
const store = $getWorkflowStaticData('global');
if (!Array.isArray(store.seen)) store.seen = [];
const seenSet = new Set(store.seen);

const now = Date.now();
const enriched = [];
const newHashes = [];

for (const item of items) {
  const raw = item.json || {};
  const article = normalizeArticle(raw, raw.feedUrl || '');
  if (!article.link) continue;

  const topicsMatched = matchTopics(article, cfg.topics);
  if (topicsMatched.length === 0) continue;

  const hash = hashLink(article.link);
  if (seenSet.has(hash)) continue;
  seenSet.add(hash);
  newHashes.push(hash);

  const relevance = scoreRelevance(article, topicsMatched, cfg.scoring, cfg.topics, now);
  const sentiment = scoreSentiment(article, cfg.lexicon);
  const entitiesFound = tagEntities(article, cfg.entities);

  enriched.push({
    title: article.title,
    link: article.link,
    source: article.source,
    publishedAt: article.publishedAt,
    summary: article.summary,
    topics: topicsMatched.join(', '),
    topicsList: topicsMatched,
    entities: entitiesFound.join(', '),
    entitiesList: entitiesFound,
    relevance,
    sentiment: sentiment.label,
    sentimentScore: sentiment.score,
    hash,
    scannedAt: new Date(now).toISOString()
  });
}

// Persist seen-list, trimmed FIFO.
store.seen = [...store.seen, ...newHashes].slice(-1 * (cfg.seenCap || 5000));

enriched.sort((a, b) => b.relevance - a.relevance);
return enriched.map(a => ({ json: a }));
`;

const buildDigestCode = `// Build Digest: render scored HTML email digests, one output item per email.
// Default: a single full digest to digest.to. With digest.routes configured,
// also one filtered digest per route so each team gets only its own topics.
// Every output item carries a 'total' count used by Has Matches? to skip empty runs.
const cfg = $('Config').first().json;
const digestCfg = cfg.digest || {};
const minRel = digestCfg.minRelevance ?? 0;
const maxItems = digestCfg.maxItems ?? 50;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function badge(label, color) {
  return \`<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:\${color};color:#fff;font-size:11px;font-weight:600;margin-right:6px;">\${escapeHtml(label)}</span>\`;
}

function sentimentColor(s) {
  if (s === 'positive') return '#137333';
  if (s === 'negative') return '#b3261e';
  return '#5f6368';
}
function relevanceColor(r) {
  if (r >= 70) return '#0b8043';
  if (r >= 40) return '#ef6c00';
  return '#9aa0a6';
}

const all = items
  .map(i => i.json)
  .filter(a => (a.relevance ?? 0) >= minRel)
  .slice(0, maxItems);

const dateStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

// route = null renders the full digest; a route object filters to route.topics.
function renderDigest(articles, route) {
  const topicFilter = route && Array.isArray(route.topics) && route.topics.length ? route.topics : null;
  const byTopic = {};
  const counted = new Set();
  for (const a of articles) {
    for (const t of (a.topicsList || [])) {
      if (topicFilter && !topicFilter.includes(t)) continue;
      (byTopic[t] = byTopic[t] || []).push(a);
      counted.add(a.hash || a.link);
    }
  }
  const topicNames = Object.keys(byTopic).sort();
  const total = counted.size;
  const audience = route && route.name ? route.name + ': ' : '';
  const subject = \`\${digestCfg.subjectPrefix || '[MediaMonitor]'} \${audience}\${total} match\${total === 1 ? '' : 'es'}: \${dateStr}\`;

  let body = \`
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#202124;max-width:760px;margin:0 auto;">
  <h1 style="font-size:22px;margin:0 0 4px 0;">Media Monitor digest\${route && route.name ? ' &middot; ' + escapeHtml(route.name) : ''}</h1>
  <div style="color:#5f6368;font-size:13px;margin-bottom:24px;">
    \${dateStr} &middot; \${total} new match\${total === 1 ? '' : 'es'}
    \${topicNames.length ? '&middot; topics: ' + topicNames.map(escapeHtml).join(', ') : ''}
  </div>
\`;

  if (total === 0) {
    body += '<p style="color:#5f6368;">No new matches in this run.</p>';
  } else {
    for (const topic of topicNames) {
      const articles2 = byTopic[topic].slice().sort((a, b) => b.relevance - a.relevance);
      body += \`<h2 style="font-size:16px;margin:24px 0 8px 0;border-bottom:1px solid #dadce0;padding-bottom:4px;">\${escapeHtml(topic)} <span style="color:#5f6368;font-weight:400;font-size:13px;">(\${articles2.length})</span></h2>\`;
      body += '<ul style="list-style:none;padding:0;margin:0;">';
      for (const a of articles2) {
        const published = a.publishedAt ? new Date(a.publishedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '';
        const ents = (a.entitiesList || []).map(e => badge(e, '#1a73e8')).join('');
        body += \`
        <li style="margin:0 0 14px 0;padding:10px 12px;border:1px solid #e8eaed;border-radius:8px;">
          <div style="margin-bottom:4px;">
            \${badge(a.relevance + '%', relevanceColor(a.relevance))}
            \${badge(a.sentiment, sentimentColor(a.sentiment))}
            <span style="color:#5f6368;font-size:12px;">\${escapeHtml(a.source)} &middot; \${escapeHtml(published)}</span>
          </div>
          <div style="font-size:15px;font-weight:600;margin-bottom:4px;">
            <a href="\${escapeHtml(a.link)}" style="color:#1a73e8;text-decoration:none;">\${escapeHtml(a.title)}</a>
          </div>
          <div style="color:#3c4043;font-size:13px;line-height:1.4;margin-bottom:6px;">
            \${escapeHtml((a.summary || '').slice(0, 280))}\${(a.summary || '').length > 280 ? '&hellip;' : ''}
          </div>
          \${ents ? '<div>' + ents + '</div>' : ''}
        </li>\`;
      }
      body += '</ul>';
    }
  }

  body += \`
  <hr style="border:none;border-top:1px solid #dadce0;margin:28px 0 8px 0;">
  <div style="color:#9aa0a6;font-size:11px;">media-monitor &middot; rule-based &middot; self-hosted n8n</div>
</div>\`;

  return { subject, html: body, total };
}

const out = [];

if (digestCfg.to) {
  const full = renderDigest(all, null);
  out.push({ json: { to: digestCfg.to, from: digestCfg.from, subject: full.subject, html: full.html, total: full.total } });
}

for (const route of (Array.isArray(digestCfg.routes) ? digestCfg.routes : [])) {
  if (!route || !route.to || !Array.isArray(route.topics) || route.topics.length === 0) continue;
  const r = renderDigest(all, route);
  out.push({ json: { to: route.to, from: digestCfg.from, subject: r.subject, html: r.html, total: r.total } });
}

return out;
`;

// ---- Sticky-note content ----------------------------------------------------
// On-canvas documentation for the n8n template reviewer. No em dashes.
// One lean yellow overview (guideline floor: 100 words, must contain
// "How it works" + "Setup"); per-node detail lives in the section notes.

const OVERVIEW_NOTE = `## Monitor RSS feeds for brand and regulatory mentions

Rule-based media monitoring: deterministic JavaScript, no per-run API costs, one SMTP credential. Built for comms teams that scan the news for client departments, PR and brand watchers, and competitor or industry trackers.

### How it works
1. An hourly trigger starts the run; every setting lives in **Config**.
2. Feeds are fetched, then articles are matched against your topic rules, scored for relevance and sentiment, entity-tagged, and de-duplicated across runs.
3. One scored HTML digest per audience: the full digest plus one per route in digest.routes. Empty runs are skipped.

### Setup
1. Edit **Config**: feeds, topics, entities, recipients.
2. Attach an SMTP credential on **Send Email**.
3. Run once to test, then activate.

The notes on each section explain the details.`;

const SECTION_A_NOTE = `### 1. Schedule + Config
Hourly by default; change the interval in the trigger. **Config** is the only node you edit: feeds, topics, entities, scoring, lexicon, and the digest recipients and routes.`;

const SECTION_B_NOTE = `### 2. Fetch + score
One item per feed; a broken feed does not stop the rest. **Process Articles** applies whole-word topic rules, scores relevance and sentiment, tags entities, and de-duplicates across runs via workflow static data.`;

const SECTION_C_NOTE = `### 3. Digest + send
**Build Digest** renders one scored HTML email per audience: the full digest plus one per route (per client department). **Has Matches?** skips empty runs unless digest.sendEmpty is true. Recipient addresses are placeholders in Config.`;

const SMTP_NOTE = `### Required
Attach an SMTP credential on **Send Email** before the first run.`;

// ---- Node definitions -------------------------------------------------------

const nodes = [
  {
    parameters: {
      rule: { interval: [{ field: 'hours', hoursInterval: 1 }] }
    },
    id: nodeId('Schedule Trigger'),
    name: 'Schedule Trigger',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [48, 720]
  },
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: configBody },
    id: nodeId('Config'),
    name: 'Config',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [288, 720],
    notes: 'Edit feeds[], topics[], entities, lexicon, scoring, digest, seenCap.\nSee README §Configure and examples/config.example.js.',
    notesInFlow: true
  },
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: feedUrlsCode },
    id: nodeId('Feed URLs'),
    name: 'Feed URLs',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [528, 720]
  },
  {
    parameters: {
      url: '={{ $json.url }}',
      options: {}
    },
    id: nodeId('RSS Read'),
    name: 'RSS Read',
    type: 'n8n-nodes-base.rssFeedRead',
    typeVersion: 1,
    position: [768, 720],
    onError: 'continueRegularOutput'
  },
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: processCode },
    id: nodeId('Process Articles'),
    name: 'Process Articles',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1008, 720],
    notes: 'The brain. Rule-based enrichment: topic match, relevance, sentiment, entities, dedup.\nPure functions inlined from src/lib.mjs. Reads $("Config").first().json + workflow static data.',
    notesInFlow: true
  },
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: buildDigestCode },
    id: nodeId('Build Digest'),
    name: 'Build Digest',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1264, 720]
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'has-matches-or-send-empty',
            leftValue: "={{ $json.total > 0 || $('Config').first().json.digest.sendEmpty === true }}",
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true }
          }
        ],
        combinator: 'and'
      },
      options: {}
    },
    id: nodeId('Has Matches?'),
    name: 'Has Matches?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [1504, 720],
    notes: 'Drops digests with zero matches unless digest.sendEmpty is true.',
    notesInFlow: true
  },
  {
    parameters: {
      fromEmail: '={{ $json.from }}',
      toEmail: '={{ $json.to }}',
      subject: '={{ $json.subject }}',
      emailFormat: 'html',
      html: '={{ $json.html }}',
      options: {}
    },
    id: nodeId('Send Email'),
    name: 'Send Email',
    type: 'n8n-nodes-base.emailSend',
    typeVersion: 2,
    position: [1744, 752]
  },
  {
    parameters: {},
    id: nodeId('Skip Empty Run'),
    name: 'Skip Empty Run',
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: [1744, 896]
  }
];

// Sticky notes. The yellow overview sits top-left clear of everything; the
// gray section notes stretch over the node groups they label (nodes render on
// top of stickies); the red note flags the one credential step on Send Email.
const stickyNotes = [
  {
    parameters: { content: OVERVIEW_NOTE, width: 780, height: 416 },
    id: nodeId('Sticky Overview'),
    name: 'Sticky Overview',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [0, 64]
  },
  {
    parameters: { content: SECTION_A_NOTE, color: 7, width: 452, height: 360 },
    id: nodeId('Sticky Section A'),
    name: 'Sticky Section A',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [0, 528]
  },
  {
    parameters: { content: SECTION_B_NOTE, color: 7, width: 732, height: 360 },
    id: nodeId('Sticky Section B'),
    name: 'Sticky Section B',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [480, 528]
  },
  {
    parameters: { content: SECTION_C_NOTE, color: 7, width: 684, height: 508 },
    id: nodeId('Sticky Section C'),
    name: 'Sticky Section C',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [1248, 528]
  },
  {
    parameters: { content: SMTP_NOTE, color: 3, width: 236, height: 92 },
    id: nodeId('Sticky SMTP Credential'),
    name: 'Sticky SMTP Credential',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [1648, 640]
  }
];

const connections = {
  'Schedule Trigger': { main: [[{ node: 'Config', type: 'main', index: 0 }]] },
  'Config':           { main: [[{ node: 'Feed URLs', type: 'main', index: 0 }]] },
  'Feed URLs':        { main: [[{ node: 'RSS Read', type: 'main', index: 0 }]] },
  'RSS Read':         { main: [[{ node: 'Process Articles', type: 'main', index: 0 }]] },
  'Process Articles': { main: [[{ node: 'Build Digest', type: 'main', index: 0 }]] },
  'Build Digest':     { main: [[{ node: 'Has Matches?', type: 'main', index: 0 }]] },
  'Has Matches?':     { main: [
    [{ node: 'Send Email', type: 'main', index: 0 }],
    [{ node: 'Skip Empty Run', type: 'main', index: 0 }]
  ] }
};

const workflow = {
  name: 'Monitor RSS feeds for brand and regulatory mentions with rule-based scoring and email digests',
  nodes: [...stickyNotes, ...nodes],
  pinData: {},
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  versionId: nodeId('versionId'),
  meta: {},
  tags: []
};

const outPath = join(ROOT, 'workflows', 'media-monitor.workflow.json');
const out = JSON.stringify(workflow, null, 2) + '\n';

if (process.argv.includes('--check')) {
  if (!existsSync(outPath)) {
    console.error('check: ' + outPath + ' missing, run `node scripts/build-workflow.mjs` first');
    process.exit(1);
  }
  const current = readFileSync(outPath, 'utf8');
  if (current !== out) {
    console.error('check: workflow JSON drifted from src/lib.mjs + examples/config.example.js');
    console.error('       run `node scripts/build-workflow.mjs` and commit the result');
    process.exit(1);
  }
  console.log('check: workflow JSON is in sync');
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out, 'utf8');
  console.log('wrote', outPath, '(' + JSON.stringify(workflow).length + ' bytes)');
}
