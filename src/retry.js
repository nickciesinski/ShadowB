'use strict';
// =============================================================
// src/retry.js — generic transient-retry with exponential backoff.
//
// Dependency-free + injectable (isTransient, sleep) so it is offline-testable.
// Used by src/sheets.js for Google API calls and, importantly, for a patient
// pre-warm of the OAuth token (the token endpoint has been intermittently
// dropping connections — "Premature close" — for longer than the old ~8s budget).
// =============================================================

/**
 * @param {string} label
 * @param {() => Promise<any>} thunk
 * @param {Object} [opts] { tries, baseMs, maxMs, isTransient, sleep, log }
 */
async function withRetry(label, thunk, opts = {}) {
  const {
    tries = 4,
    baseMs = 800,
    maxMs = Infinity,
    isTransient = () => true,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console,
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await thunk();
    } catch (err) {
      lastErr = err;
      if (attempt === tries || !isTransient(err)) throw err;
      const backoff = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
      const delay = backoff + Math.floor(Math.random() * 250);
      log.warn(`[retry] ${label}: transient error (attempt ${attempt}/${tries}) — ${err.message}; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
