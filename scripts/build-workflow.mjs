// Builds workflows/media-monitor.workflow.json from the lib + config + node
// bodies defined below. Run: `node scripts/build-workflow.mjs`.
// Keeping this so re-generating the workflow after editing the lib is an
// easy one-liner instead of a hand-escaped JSON edit.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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

const processCode = `// Process Articles — rule-based enrichment.
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

const buildDigestCode = `// Build Digest — aggregate all input items into ONE HTML email item.
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

const all = items
  .map(i => i.json)
  .filter(a => (a.relevance ?? 0) >= minRel)
  .slice(0, maxItems);

const byTopic = {};
for (const a of all) {
  for (const t of (a.topicsList || [])) {
    (byTopic[t] = byTopic[t] || []).push(a);
  }
}
const topicNames = Object.keys(byTopic).sort();

const dateStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const total = all.length;
const subject = \`\${digestCfg.subjectPrefix || '[MediaMonitor]'} \${total} match\${total === 1 ? '' : 'es'} — \${dateStr}\`;

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

let body = \`
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#202124;max-width:760px;margin:0 auto;">
  <h1 style="font-size:22px;margin:0 0 4px 0;">Media Monitor digest</h1>
  <div style="color:#5f6368;font-size:13px;margin-bottom:24px;">
    \${dateStr} &middot; \${total} new match\${total === 1 ? '' : 'es'}
    \${topicNames.length ? '&middot; topics: ' + topicNames.map(escapeHtml).join(', ') : ''}
  </div>
\`;

if (total === 0) {
  body += '<p style="color:#5f6368;">No new matches in this run.</p>';
} else {
  for (const topic of topicNames) {
    const articles = byTopic[topic].slice().sort((a, b) => b.relevance - a.relevance);
    body += \`<h2 style="font-size:16px;margin:24px 0 8px 0;border-bottom:1px solid #dadce0;padding-bottom:4px;">\${escapeHtml(topic)} <span style="color:#5f6368;font-weight:400;font-size:13px;">(\${articles.length})</span></h2>\`;
    body += '<ul style="list-style:none;padding:0;margin:0;">';
    for (const a of articles) {
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
  <div style="color:#9aa0a6;font-size:11px;">media-monitor &middot; rule-based, no LLM &middot; self-hosted n8n</div>
</div>\`;

return [{
  json: {
    to: digestCfg.to,
    from: digestCfg.from,
    subject,
    html: body
  }
}];
`;

// ---- Node definitions -------------------------------------------------------

const nodes = [
  {
    parameters: {
      rule: { interval: [{ field: 'hours', hoursInterval: 1 }] }
    },
    id: randomUUID(),
    name: 'Schedule Trigger',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [-200, 0]
  },
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: configBody },
    id: randomUUID(),
    name: 'Config',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [40, 0]
  },
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: feedUrlsCode },
    id: randomUUID(),
    name: 'Feed URLs',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [280, 0]
  },
  {
    parameters: {
      url: '={{ $json.url }}',
      options: {}
    },
    id: randomUUID(),
    name: 'RSS Read',
    type: 'n8n-nodes-base.rssFeedRead',
    typeVersion: 1,
    position: [520, 0],
    onError: 'continueRegularOutput'
  },
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: processCode },
    id: randomUUID(),
    name: 'Process Articles',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [760, 0]
  },
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: buildDigestCode },
    id: randomUUID(),
    name: 'Build Digest',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1020, 0]
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
    id: randomUUID(),
    name: 'Send Email',
    type: 'n8n-nodes-base.emailSend',
    typeVersion: 2,
    position: [1280, 0]
  }
];

const connections = {
  'Schedule Trigger': { main: [[{ node: 'Config', type: 'main', index: 0 }]] },
  'Config':           { main: [[{ node: 'Feed URLs', type: 'main', index: 0 }]] },
  'Feed URLs':        { main: [[{ node: 'RSS Read', type: 'main', index: 0 }]] },
  'RSS Read':         { main: [[{ node: 'Process Articles', type: 'main', index: 0 }]] },
  'Process Articles': { main: [[{ node: 'Build Digest', type: 'main', index: 0 }]] },
  'Build Digest':     { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] }
};

const workflow = {
  name: 'Media Monitor — rule-based',
  nodes,
  pinData: {},
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  versionId: randomUUID(),
  meta: { instanceId: 'media-monitor' },
  id: 'media-monitor',
  tags: []
};

const outPath = join(ROOT, 'workflows', 'media-monitor.workflow.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(workflow, null, 2) + '\n', 'utf8');
console.log('wrote', outPath, '(' + JSON.stringify(workflow).length + ' bytes)');
