'use strict';
// =============================================================
// src/auth-cache.js — decide whether a cached Google access token is reusable.
//
// Google's OAuth token endpoint (www.googleapis.com/oauth2/v4/token) has been
// intermittently dropping connections ("Premature close") for minutes at a time,
// failing nearly every trigger. Access tokens live ~1h, so instead of every run
// independently fighting the flaky endpoint, the first run that succeeds caches
// its token (in Supabase, which is reachable even when Google's endpoint isn't)
// and the rest reuse it.
//
// This module holds only the PURE reuse decision so it is offline-testable; the
// Supabase I/O lives in db.js and the googleapis wiring in sheets.js.
// =============================================================

// Require comfortably more remaining life than the longest trigger run (trigger14
// has taken >12 min) so a reused token can't expire mid-run.
const MIN_REMAINING_MS = 20 * 60 * 1000;

/**
 * @param {{access_token?:string, expiry_date?:number}|null} cached
 * @param {number} [nowMs]
 * @param {number} [minRemainingMs]
 * @returns {boolean}
 */
function isUsableToken(cached, nowMs = Date.now(), minRemainingMs = MIN_REMAINING_MS) {
  if (!cached || !cached.access_token || !cached.expiry_date) return false;
  const remaining = Number(cached.expiry_date) - nowMs;
  return Number.isFinite(remaining) && remaining >= minRemainingMs;
}

module.exports = { isUsableToken, MIN_REMAINING_MS };
