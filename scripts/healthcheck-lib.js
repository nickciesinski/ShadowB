'use strict';
// =============================================================
// scripts/healthcheck-lib.js
//
// Pure, dependency-free helpers for the sheets-exit health check. Kept separate
// from sheets-exit-healthcheck.js (which pulls in nodemailer / Supabase / config)
// so the alert-vs-noise logic is offline-unit-testable.
// =============================================================

// >10% (and >2 rows) row-count gap => real divergence between Sheet and Supabase.
const COUNT_TOLERANCE = 0.10;

// Transient infra errors — OAuth token "Premature close", dropped sockets, DNS
// hiccups, 5xx, rate limits. These self-heal and say NOTHING about whether the
// Supabase shadow diverged, so they must be retried and never paged on their own.
const TRANSIENT_RE = /premature close|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|fetch failed|invalid response body|terminated|\b(429|500|502|503|504)\b|timed? ?out/i;

function isTransientError(err) {
  const m = (err && (err.message || String(err))) || '';
  return TRANSIENT_RE.test(m);
}

// Retry a thunk on transient errors only; rethrow immediately on real errors.
async function withRetry(fn, { tries = 3, baseMs = 500, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i === tries - 1 || !isTransientError(e)) throw e;
      await wait(baseMs * (i + 1));
    }
  }
  throw lastErr;
}

function diverges(a, b, tolerance = COUNT_TOLERANCE) {
  const gap = Math.abs(a - b);
  return gap > 2 && gap > tolerance * Math.max(a, 1);
}

module.exports = { isTransientError, withRetry, diverges, COUNT_TOLERANCE, TRANSIENT_RE };
