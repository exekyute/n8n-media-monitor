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
      termWeight: 6,
      sourceWeight: 20,
      recencyWeight: 30,
      recencyHalfLifeHours: 48,
      sources: {
        "reuters.com": 1.5,
        "bbc.co.uk":   1.4,
        "techcrunch.com": 1.2,
        "theverge.com": 1.1,
        default: 1.0
      }
    },

    // ---- 4. Sentiment lexicon -----------------------------------------------
    // AFINN-style word → integer score (typical −5..+5). Sum is normalised by
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
      to: "ops@example.com",
      from: "monitor@example.com"
    },

    // ---- 7. Dedup --------------------------------------------------------
    // Max number of link hashes kept in workflow static data. Older entries
    // are dropped FIFO.
    seenCap: 5000
  }
}];
