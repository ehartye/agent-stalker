// All tunable thresholds for structured analytics. No magic numbers elsewhere.
export const ANALYTICS_CONFIG = {
  // Error→retry chain: a failure followed by another call to the same tool+target
  // by the same agent within this window counts as a retry link.
  retryWindowMs: 2 * 60 * 1000,
  // Tool retry: this many near-consecutive same-tool+target calls by one agent = thrash.
  retryMinRepeats: 3,
  // Churn: a file edited at least this many times in one session is a churn hotspot.
  churnMinEdits: 3,
  // Pain score weights (normalized signals, should roughly sum to 1).
  painWeights: {
    errorRate: 0.3,
    churn: 0.2,
    thrash: 0.3,
    effort: 0.2,
  },
};
