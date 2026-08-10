// ── debug-probe ──────────────────────────────────────────────────────────────
//
// console.log is write-only for debugging this repo.
//
// GitHub Actions log downloads are served from
// results-receiver.actions.githubusercontent.com, which sits outside the dev
// environment's egress allowlist. Run metadata (status, steps, conclusions) is
// reachable via the API; the actual printed output is not. So a diagnostic
// written with console.log can confirm a job succeeded and nothing more --
// which is useless precisely when a job succeeds while producing wrong data.
// That is the failure mode this system keeps hitting.
//
// Anything needed to DIAGNOSE (as opposed to narrate) goes here instead, into
// a table that can be queried directly. Keep console.log for narration.
//
// Cheap, best-effort, and never throws: a probe must not be able to break the
// job it is observing.

const db = require('./db');

const MAX_PAYLOAD_CHARS = 40000;

/**
 * Record a diagnostic observation.
 *
 * @param {string} source  module emitting it, e.g. 'data-collection'
 * @param {string} label   what it is, e.g. 'mlb-espn-keys'
 * @param {Object} payload any JSON-serialisable detail
 */
async function probe(source, label, payload) {
  try {
    if (!db.isEnabled || !db.isEnabled()) return false;
    const sb = db.getClient();
    if (!sb) return false;

    let body = payload === undefined ? null : payload;
    // Guard the column rather than the caller: a probe that fails because
    // someone passed a huge object is a probe that will get deleted instead of
    // fixed. Truncate and say so.
    if (body !== null) {
      const s = JSON.stringify(body);
      if (s && s.length > MAX_PAYLOAD_CHARS) {
        body = { _truncated: true, _original_chars: s.length,
                 preview: s.slice(0, MAX_PAYLOAD_CHARS) };
      }
    }

    const { error } = await sb.from('debug_probe').insert([{
      source: String(source || 'unknown').slice(0, 120),
      label: String(label || 'unlabelled').slice(0, 200),
      payload: body,
    }]);
    if (error) {
      console.warn(`[debug-probe] insert failed (${label}): ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[debug-probe] threw (${label}): ${err.message}`);
    return false;
  }
}

/**
 * Convenience: record the keys and values of an upstream API response so the
 * shape can be inspected later without re-fetching. `filter` narrows a wide
 * object to the interesting subset (a regex against the key name).
 */
async function probeKeys(source, label, obj, filter, extra = {}) {
  const keys = {};
  try {
    for (const [k, v] of Object.entries(obj || {})) {
      if (!filter || filter.test(k)) keys[k] = v;
    }
  } catch (e) { /* fall through with whatever was collected */ }
  return probe(source, label, { ...extra, matched_keys: keys,
    total_keys: Object.keys(obj || {}).length });
}

module.exports = { probe, probeKeys };
