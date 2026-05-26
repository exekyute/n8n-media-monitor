const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' '
};

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\/?\s*(p|div|li|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, m => HTML_ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeHostname(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(term) {
  // Whole-word, case-insensitive. \b works for ASCII; phrases with spaces
  // get \b on the outer tokens which is the common-case intent.
  return new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
}

function countMatches(haystack, term) {
  const m = haystack.match(termRegex(term));
  return m ? m.length : 0;
}

function hasMatch(haystack, term) {
  return termRegex(term).test(haystack);
}

export function normalizeArticle(raw, feedUrl) {
  const title = stripHtml(raw?.title ?? '');
  const link = String(raw?.link ?? raw?.url ?? raw?.guid ?? '').trim();
  const summary = stripHtml(raw?.contentSnippet ?? raw?.summary ?? raw?.description ?? '');
  const content = stripHtml(raw?.content ?? raw?.['content:encoded'] ?? '');
  const contentText = (content && content.length > summary.length) ? content : summary;
  const published = raw?.isoDate ?? raw?.pubDate ?? raw?.published ?? raw?.date ?? null;
  let publishedAt;
  if (published) {
    const d = new Date(published);
    publishedAt = isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } else {
    publishedAt = new Date().toISOString();
  }
  const source = safeHostname(link) || safeHostname(feedUrl) || '';
  return { title, link, source, publishedAt, summary, contentText };
}

export function hashLink(link) {
  if (!link) return '0';
  let normalized = String(link).trim().toLowerCase();
  try {
    const u = new URL(normalized);
    u.hash = '';
    const drop = [];
    for (const k of u.searchParams.keys()) {
      if (k.startsWith('utm_') || k === 'gclid' || k === 'fbclid' || k === 'mc_cid' || k === 'mc_eid') {
        drop.push(k);
      }
    }
    drop.forEach(k => u.searchParams.delete(k));
    normalized = `${u.protocol}//${u.hostname}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    normalized = normalized.replace(/#.*$/, '').replace(/\/$/, '');
  }
  // djb2 32-bit
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    h = (((h << 5) + h) + normalized.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function matchTopics(article, topics) {
  const hay = `${article.title ?? ''} ${article.contentText ?? ''}`;
  const matched = [];
  for (const t of topics ?? []) {
    const include = t.include ?? [];
    const exclude = t.exclude ?? [];
    if (include.length === 0) continue;
    const allInclude = include.every(term => hasMatch(hay, term));
    if (!allInclude) continue;
    const anyExclude = exclude.some(term => hasMatch(hay, term));
    if (anyExclude) continue;
    matched.push(t.name);
  }
  return matched;
}

export function scoreRelevance(article, topicsMatched, scoring, allTopics, now = Date.now()) {
  if (!topicsMatched || topicsMatched.length === 0) return 0;
  const cfg = scoring ?? {};
  const termWeight = cfg.termWeight ?? 6;
  const sourceWeight = cfg.sourceWeight ?? 20;
  const recencyWeight = cfg.recencyWeight ?? 30;
  const halfLife = cfg.recencyHalfLifeHours ?? 48;
  const sources = cfg.sources ?? {};

  const hay = `${article.title ?? ''} ${article.contentText ?? ''}`;
  let hits = 0;
  for (const tName of topicsMatched) {
    const t = (allTopics ?? []).find(x => x.name === tName);
    if (!t) continue;
    for (const term of t.include ?? []) {
      hits += countMatches(hay, term);
    }
  }
  // cap hits so a keyword-stuffed article doesn't dominate
  const cappedHits = Math.min(hits, 10);
  const termComponent = cappedHits * termWeight;

  const srcMultiplier = sources[article.source] ?? sources.default ?? 1;
  const sourceComponent = sourceWeight * Math.min(srcMultiplier, 2); // clamp absurd weights

  const published = new Date(article.publishedAt ?? now).getTime();
  const hoursOld = Math.max(0, (now - published) / 36e5);
  const recencyComponent = recencyWeight * Math.max(0, 1 - hoursOld / halfLife);

  const total = termComponent + sourceComponent + recencyComponent;
  return Math.max(0, Math.min(100, Math.round(total)));
}

export function scoreSentiment(article, lexicon) {
  const text = `${article.title ?? ''} ${article.contentText ?? ''}`.toLowerCase();
  const tokens = text.match(/[a-z][a-z'-]+/g) ?? [];
  if (tokens.length === 0) return { score: 0, label: 'neutral' };
  let raw = 0;
  for (const tok of tokens) {
    const v = lexicon?.[tok];
    if (typeof v === 'number') raw += v;
  }
  const score = raw / Math.sqrt(tokens.length);
  const rounded = Math.round(score * 100)
