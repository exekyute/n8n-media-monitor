// examples/config.example.js
//
// Copy the body of this file (everything inside the `return [...]` block)
// into the **Config** Code node in n8n. It must run with mode
// "Run Once for All Items" and JavaScript language.
//
// All downstream nodes read this config via:
//   const cfg = $('Config').first().json;
//
// Edit feeds[], topics[], entities, lexicon, scoring, and digest to taste.

return [{
  json: {
    // ---- 1. Sources ----------------------------------------------------------
    // Any RSS/Atom URL. One bad feed will not stop the others (RSS Read is set
    // to continueRegularOutput).
    feeds: [
      "https://www.theverge.com/rss/index.xml",
      "https://techcrunch.com/feed/",
      "https://www.reuters.com/business/finance/rss",
      "https://feeds.bbci.co.uk/news/business/rss.xml"
    ],

    // ---- 2. Topics -----------------------------------------------------------
    // Each topic has an include list (ALL terms must be present, boolean AND)
    // and an exclude list (any match → topic skipped). Whole-word, case-
    // insensitive. An article that matches NO topic is dropped.
    topics: [
      {
        name: "BrandMentions",
        include: ["acme"],
        exclude: ["acme tool company", "wile e coyote"]
      },
      {
        name: "Competitors",
        include: ["globex"],
        exclude: []
      },
      {
        name: "RegulatoryNews",
        include: ["regulation"],
        exclude: ["sports", "fashion"]
      }
    ],

    // ---- 3. Scoring ----------------------------------------------------------
    // Relevance score = clamp(0..100, round(
    //   termWeight   * min(totalIncludeHits, 10)
    // + sourceWeight * min(sources[host] || sources.default || 1, 2)
    // + recencyWeight * max(0, 1 - hoursOld / recencyHalfLifeHours)
    // ))
    scoring: {
      termWeight: 6,            // raise to ~12 if you want keyword density to dominate (good for very specific brand names)
      sourceWeight: 20,         // raise if you trust a few outlets a lot more than the rest
      recencyWeight: 30,        // lower to ~10 for slow-moving regulatory/industry feeds; raise for breaking-news monitoring
      recencyHalfLifeHours: 48, // raise to 168 (1 week) for weekly digests; lower to 12 for "what happened overnight"
      sources: {
        "reuters.com": 1.5,
        "bbc.co.uk":   1.4,
        "techcrunch.com": 1.2,
        "theverge.com": 1.1,
        default: 1.0           // anything not listed above gets this multiplier
      }
    },

    // ---- 4. Sentiment lexicon -----------------------------------------------
    // AFINN-style word → integer score (typical −5..+5). Sum is normalized by
    // sqrt(tokenCount) so long articles don't dominate. Label thresholds:
    //   ≥ +0.5 → positive,  ≤ -0.5 → negative,  else neutral.
    lexicon: {
      surge: 3, soar: 3, beat: 2, growth: 2, profit: 2, win: 2, gain: 2,
      record: 1, upbeat: 2, strong: 1, rise: 1, rally: 2,
      loss: -2, miss: -2, slump: -3, plunge: -3, fall: -1, drop: -1,
      lawsuit: -3, fraud: -4, breach: -3, scandal: -3, fine: -2, probe: -2,
      layoff: -3, layoffs: -3, recall: -2, hack: -3, outage: -2
    },

    // ---- 5. Entity dictionary -----------------------------------------------
    // Label → list of aliases. Whole-word, case-insensitive. Each label is
    // attached at most once per article.
    entities: {
      "Acme Corp":  ["acme", "acme corp", "acmecorp"],
      "Globex Inc": ["globex", "globex corp"],
      "Initech":    ["initech"]
    },

    // ---- 6. Digest email ----------------------------------------------------
    digest: {
      subjectPrefix: "[MediaMonitor]",
      minRelevance: 30,   // hide low-score noise from the email
      maxItems: 50,       // hard cap across all topics
      to: "ops@example.com",      // full-digest recipient; set to "" to send routed digests only
      from: "monitor@example.com",
      sendEmpty: false,   // true = also email runs with zero matches ("No new matches")

      // Routes: one EXTRA email per entry, filtered to the listed topics.
      // Lets a comms desk send each client department only its own coverage.
      // An article matching two routed topics appears in both emails.
      routes: [
        // { name: "Environment Dept", to: "env-comms@example.gov",   topics: ["RegulatoryNews"] },
        // { name: "Trade Dept",       to: "trade-comms@example.gov", topics: ["Competitors"] }
      ]
    },

    // ---- 7. Dedup --------------------------------------------------------
    // Max number of link hashes kept in workflow static data. Older entries
    // are dropped FIFO.
    seenCap: 5000
  }
}];

// ---- Starter-pack topics (uncomment and rename to use) ----------------------
// Drop any of these into topics[] above. Replace the placeholder terms with
// your real brand/competitor/regulator/industry keywords.
//
//   { name: "OwnBrand",        include: ["yourbrand"],         exclude: [] },
//   { name: "Top3Competitors", include: ["competitor"],        exclude: [] },
//   { name: "RegulatoryRisk",  include: ["regulator"],         exclude: ["sports"] },
//   { name: "IndustryGeneral", include: ["fintech"],           exclude: ["crypto"] },
//   { name: "Tourism",         include: ["tourism"],           exclude: [] },
//   { name: "Hospitality",     include: ["hotel"],             exclude: ["hotel california"] },
//   { name: "Cruise",          include: ["cruise"],            exclude: ["tom cruise", "cruise missile"] },
