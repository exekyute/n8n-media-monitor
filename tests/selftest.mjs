// Self-test for media-monitor lib. Run: `node tests/selftest.mjs`
// Asserts boolean topic match, exclude suppression, whole-word boundaries,
// relevance bands, sentiment labels, entity tagging, normalization, link
// hashing, and dedup via a Set (mimics n8n static-data seen-list).

import assert from 'node:assert/strict';
import {
  normalizeArticle, hashLink, matchTopics,
  scoreRelevance, scoreSentiment, tagEntities,
  truncateSummary
} from '../src/lib.mjs';

const topics = [
  { name: 'BrandX',      include: ['acme'],   exclude: ['acme tool company'] },
  { name: 'Competitors', include: ['globex'], exclude: ['lawsuit'] },
  { name: 'PreciseMatch', include: ['mac'],   exclude: [] }
];

const scoring = {
  termWeight: 6, sourceWeight: 20, recencyWeight: 30,
  recencyHalfLifeHours: 48,
  sources: { 'reuters.com': 1.5, 'techcrunch.com': 1.2, default: 1.0 }
};

const lexicon = {
  surge: 3, growth: 2, profit: 2, win: 2, beat: 2,
  loss: -2, lawsuit: -3, fraud: -4, breach: -3, plunge: -3
};

const entities = {
  'Acme Corp':  ['acme', 'acme corp', 'acmecorp'],
  'Globex Inc': ['globex'],
  'Initech':    ['initech']
};

const NOW = Date.parse('2026-05-25T12:00:00Z');
const FRESH = new Date(NOW - 1 * 3600 * 1000).toISOString();      // 1h old
const OLD   = new Date(NOW - 240 * 3600 * 1000).toISOString();    // 10d old

let passed = 0, total = 0;
function t(name, fn) {
  total++;
  try { fn(); passed++; console.log(`ok  - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n${e.stack || e.message}`); }
}

// 1. Topic match + exclude suppression
t('matchTopics: BrandX hits; Competitors suppressed by exclude', () => {
  const a = {
    title: 'Acme posts record growth',
    contentText: 'Globex hit with lawsuit over patents.'
  };
  const m = matchTopics(a, topics);
  assert.ok(m.includes('BrandX'), 'BrandX should match');
  assert.ok(!m.includes('Competitors'), 'Competitors must be suppressed by "lawsuit"');
});

// 2. Whole-word boundary
t('matchTopics: "mac" does not match inside "macro"', () => {
  const a = { title: 'Macro trends in tech', contentText: 'macroeconomic outlook' };
  const m = matchTopics(a, topics);
  assert.ok(!m.includes('PreciseMatch'), '"mac" must not match inside "macro"');
});

// 3. Relevance bands
t('scoreRelevance: high for fresh + boosted source + many hits', () => {
  const a = {
    title: 'Acme Acme Acme launches',
    contentText: 'Acme reports another acme milestone. acme acme.',
    source: 'reuters.com',
    publishedAt: FRESH
  };
  const matched = matchTopics(a, topics);
  const s = scoreRelevance(a, matched, scoring, topics, NOW);
  assert.ok(s >= 70, `expected >=70, got ${s}`);
});

t('scoreRelevance: low for old + generic source + single hit', () => {
  const a = {
    title: 'Brief mention of acme',
    contentText: 'short note.',
    source: 'somerandomblog.example',
    publishedAt: OLD
  };
  const matched = matchTopics(a, topics);
  const s = scoreRelevance(a, matched, scoring, topics, NOW);
  assert.ok(s <= 30, `expected <=30, got ${s}`);
});

// 4. Sentiment labels
t('scoreSentiment: positive', () => {
  const a = { title: 'Surge in profit', contentText: 'growth growth win beat' };
  assert.equal(scoreSentiment(a, lexicon).label, 'positive');
});
t('scoreSentiment: negative', () => {
  const a = { title: 'Fraud and breach', contentText: 'lawsuit plunge loss' };
  assert.equal(scoreSentiment(a, lexicon).label, 'negative');
});
t('scoreSentiment: neutral', () => {
  const a = { title: 'Quarterly note', contentText: 'company released document today' };
  assert.equal(scoreSentiment(a, lexicon).label, 'neutral');
});

// 5. Entity tagging via alias
t('tagEntities: alias "AcmeCorp" tags "Acme Corp"', () => {
  const a = { title: 'AcmeCorp ships product', contentText: '' };
  const tags = tagEntities(a, entities);
  assert.deepEqual(tags, ['Acme Corp']);
});

// 6. normalizeArticle: HTML stripped, source = hostname
t('normalizeArticle: HTML stripped, source = hostname', () => {
  const raw = {
    title: 'Hello <b>world</b>',
    link: 'https://www.example.com/path?utm_source=x',
    summary: '<p>Body &amp; more</p>',
    pubDate: '2026-05-20T00:00:00Z'
  };
  const out = normalizeArticle(raw, 'https://example.com/feed');
  assert.equal(out.title, 'Hello world');
  assert.equal(out.summary, 'Body & more');
  assert.equal(out.source, 'example.com');
  assert.equal(new Date(out.publishedAt).toISOString(), '2026-05-20T00:00:00.000Z');
});

// 7. hashLink: utm-stripped match; different link differs
t('hashLink: utm-stripped equality + distinct links differ', () => {
  const a = hashLink('https://example.com/post/123?utm_source=twitter');
  const b = hashLink('https://example.com/post/123');
  const c = hashLink('https://example.com/post/123/');
  const d = hashLink('https://example.com/post/124');
  assert.equal(a, b, 'utm-stripped should equal bare');
  assert.equal(a, c, 'trailing slash should not matter');
  assert.notEqual(a, d, 'different paths should differ');
});

// 8. Dedup simulation
t('dedup: Set-based seen-list suppresses repeat', () => {
  const seen = new Set();
  const link = 'https://example.com/n/42';
  const h1 = hashLink(link);
  const firstPass = !seen.has(h1); seen.add(h1);
  const h2 = hashLink(link + '?utm_campaign=z');
  const secondPass = !seen.has(h2);
  assert.equal(firstPass, true);
  assert.equal(secondPass, false);
});

// 9. Edge case: empty article doesn't crash
t('matchTopics: empty article returns []', () => {
  assert.deepEqual(matchTopics({ title: '', contentText: '' }, topics), []);
});

// 10. Title-only hit still matches
t('matchTopics: title-only hit still matches', () => {
  const a = { title: 'Acme news', contentText: '' };
  assert.ok(matchTopics(a, topics).includes('BrandX'));
});

// 11. truncateSummary: respects word boundary + appends ellipsis
t('truncateSummary: short text passes through unchanged', () => {
  assert.equal(truncateSummary('hello world', 100), 'hello world');
});
t('truncateSummary: long text cuts at word boundary with ellipsis', () => {
  const out = truncateSummary('the quick brown fox jumps over the lazy dog', 20);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 21);
  assert.ok(!out.includes('lazy'), 'should have cut before "lazy"');
});

console.log(`\n${passed === total ? 'OK' : 'FAIL'} ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
