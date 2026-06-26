'use strict';
// =============================================================
// src/transient.js — shared transient-error classifier
//
// Single source of truth for "is this a flaky, retry-worthy error?" Used by the
// Sheets API retry layer (src/sheets.js). Dependency-free so it is unit-testable
// offline.
//
// IMPORTANT (2026-06: every trigger failed): the Google OAuth token endpoint
// intermittently drops the connection mid-response, surfacing as
//   "Invalid response body while trying to fetch .../oauth2/v4/token: Premature close"
// This is a transport hiccup, not an auth rejection — it MUST be retried. It is
// distinct from "invalid_grant"/"exceeds grid limits", which must NOT be retried
// (a bad key won't fix itself; grid-limit triggers the auto-expand path instead).
// =============================================================

const TRANSIENT_MSG = [
  'currently unavailable', 'try again', 'rate limit', 'quota exceeded',
  'backend error', 'internal error', 'deadline exceeded',
  'timeout', 'timed out', 'socket hang up', 'network', 'econnreset',
  // Transport-level fetch/undici failures (incl. the OAuth token-fetch outage):
  'premature close', 'invalid response body', 'fetch failed',
  'terminated', 'other side closed', 'connection closed',
];
const TRANSIENT_CODES_NUM = [429, 500, 502, 503, 504];
const TRANSIENT_CODES_STR = [
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED',
  'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE',
];

function isTransient(err) {
  if (!err) return false;
  const numCode = Number(err.code || err.status || (err.response && err.response.status));
  if (TRANSIENT_CODES_NUM.includes(numCode)) return true;
  if (typeof err.code === 'string' && TRANSIENT_CODES_STR.includes(err.code)) return true;
  // Walk message + nested cause (undici wraps the real error under err.cause).
  const texts = [];
  let cur = err, depth = 0;
  while (cur && depth < 5) {
    if (cur.message) texts.push(String(cur.message));
    if (typeof cur.code === 'string') texts.push(cur.code);
    cur = cur.cause; depth++;
  }
  const msg = texts.join(' ').toLowerCase();
  return TRANSIENT_MSG.some((p) => msg.includes(p));
}

module.exports = { isTransient, TRANSIENT_MSG, TRANSIENT_CODES_NUM, TRANSIENT_CODES_STR };
