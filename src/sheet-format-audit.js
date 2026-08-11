// ── sheet-format-audit ───────────────────────────────────────────────────────
//
// One-off diagnostic. Reads every sheet BOTH ways — FORMATTED_VALUE (the
// default, which is what almost all of this codebase currently uses) and
// UNFORMATTED_VALUE — and reports every cell where they disagree numerically.
//
// WHY. On 2026-08-11 the MLB Team Stats sheet was found to be silently
// corrupting values on the round trip, because values.get defaults to the
// cell's DISPLAY string:
//
//     wrote 4.55       -> read back "455.0%"   (stale percent format)
//     wrote 0.7098012  -> read back "0.7"      (1-decimal format)
//     wrote "0.600"    -> read back "1"        (0-decimal format)
//
// parseFloat("455.0%") is 455. Nothing errored; run differential simply
// contributed nothing for weeks while the column beside it worked perfectly.
//
// Stale formatting is invisible in code review and invisible in the sheet
// unless you look at the exact cell. The only way to find the rest is to
// compare the two render modes on real data, which is what this does.
//
// Reports rather than fixes: which reads should switch to unformatted is a
// judgement call per sheet, because UNFORMATTED_VALUE returns dates as serial
// numbers and would break date parsing.

const { getValues } = require('./sheets');
const { probe } = require('./debug-probe');
const { SHEETS, SPREADSHEET_ID } = require('./config');

// A difference is only interesting if it changes the NUMBER a caller would
// parse. "4.43" vs 4.43 is a type difference and harmless; "455.0%" vs 4.55 is
// data corruption. Date-like strings are reported separately, since those are
// expected to differ and are the reason this cannot be switched on globally.
function classify(fmt, raw) {
  if (fmt === raw) return null;
  const fs = String(fmt ?? '');
  const rs = String(raw ?? '');
  if (fs === '' && rs === '') return null;

  // Date-like formatted value against a numeric serial: expected, not a bug.
  const looksDate = /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|:\d{2}/.test(fs);
  if (looksDate && typeof raw === 'number') return 'date_serial';

  const fNum = parseFloat(fs.replace(/[$,%\s]/g, ''));
  const rNum = parseFloat(rs);
  if (!Number.isFinite(fNum) || !Number.isFinite(rNum)) {
    return fs.trim() === rs.trim() ? null : 'text_diff';
  }
  if (fNum === rNum) return null;               // pure formatting, same number
  const rel = Math.abs(fNum - rNum) / (Math.abs(rNum) || 1);
  if (/%/.test(fs)) return 'PERCENT_CORRUPTION'; // 4.55 -> "455.0%"
  if (rel > 0.005) return 'VALUE_CORRUPTION';    // rounded away real precision
  return 'rounding_minor';
}

async function auditSheet(sheetName, maxRows = 40) {
  const out = { sheet: sheetName, rows_checked: 0, issues: {}, samples: [] };
  let fmt; let raw;
  try {
    [fmt, raw] = await Promise.all([
      getValues(SPREADSHEET_ID, sheetName),
      getValues(SPREADSHEET_ID, sheetName, null, { unformatted: true }),
    ]);
  } catch (err) {
    return { ...out, error: err.message };
  }
  if (!fmt || !fmt.length) return { ...out, error: 'empty_or_unreadable' };

  const header = fmt[0] || [];
  const n = Math.min(fmt.length, raw.length, maxRows + 1);
  out.rows_checked = Math.max(0, n - 1);

  for (let r = 1; r < n; r++) {
    const fr = fmt[r] || []; const rr = raw[r] || [];
    const width = Math.max(fr.length, rr.length);
    for (let c = 0; c < width; c++) {
      const kind = classify(fr[c], rr[c]);
      if (!kind) continue;
      out.issues[kind] = (out.issues[kind] || 0) + 1;
      if ((kind === 'PERCENT_CORRUPTION' || kind === 'VALUE_CORRUPTION')
          && out.samples.length < 12) {
        out.samples.push({ col: c, header: header[c] ?? null,
          formatted: fr[c], unformatted: rr[c], kind });
      }
    }
  }
  return out;
}

async function runSheetFormatAudit() {
  const names = [...new Set(Object.values(SHEETS))].filter(Boolean);
  const results = [];
  for (const name of names) {
    /* eslint-disable no-await-in-loop */
    const r = await auditSheet(name);
    results.push(r);
    const bad = (r.issues.PERCENT_CORRUPTION || 0) + (r.issues.VALUE_CORRUPTION || 0);
    console.log(`[sheet-audit] ${String(name).padEnd(26)} rows=${String(r.rows_checked).padStart(3)} `
      + `corrupt=${bad} ${r.error ? `(${r.error})` : ''}`);
  }
  const corrupted = results.filter((r) =>
    (r.issues.PERCENT_CORRUPTION || 0) + (r.issues.VALUE_CORRUPTION || 0) > 0);

  await probe('sheet-format-audit', 'formatted-vs-unformatted', {
    sheets_checked: results.length,
    corrupted_sheets: corrupted.map((r) => r.sheet),
    detail: corrupted,
    clean: results.filter((r) => !corrupted.includes(r) && !r.error).map((r) => r.sheet),
    errored: results.filter((r) => r.error).map((r) => ({ sheet: r.sheet, error: r.error })),
  });
  return { corrupted: corrupted.map((r) => r.sheet), results };
}

module.exports = { runSheetFormatAudit, auditSheet, classify };
